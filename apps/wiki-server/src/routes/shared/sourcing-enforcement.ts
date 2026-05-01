import type { Context } from "hono";
import { logger as rootLogger } from "../../logger.js";
import { validationError } from "./utils.js";

const logger = rootLogger.child({ component: "sourcing-enforcement" });

/**
 * Server-side sourcing requirements — independent of client params.
 *
 * When a table is listed here as `true`, the sync endpoint requires every
 * record to include inline sourcing data. This enforcement is server-side
 * and cannot be bypassed by omitting query parameters.
 *
 * Rollout per Discussion #3875: tables are enabled here as they reach Phase 5.
 */
const SOURCE_CHECK_REQUIRED: Record<string, boolean> = {
  // Phase 5 hard enforcement (Discussion #3875):
  // Personnel: 91% coverage (380 confirmed / 417 actionable), enabled 2026-04-08
  personnel: true,
  // Grants: 99.5% coverage (5078 confirmed / 5102 actionable), enabled 2026-04-08
  grants: true,
  // Phase 7 expansion (QUA-248), enabled 2026-04-11:
  "funding-rounds": true,
  "funding-programs": true,
  divisions: true,
  "policy-stakeholders": true,
};

/**
 * Resolve whether sourcing is required for this request, given the route's
 * table name and the request's query params. Used by both the atomic
 * `enforceSourcing()` path and the best-effort partitioning path (QUA-955) so
 * the policy decision lives in one place.
 *
 *   - `not_required` — neither server config nor client param requests sourcing
 *   - `skipped` — sourcing was required but `?forceSkipSourcing=true` was set
 *   - `required` — every item must include sourcing data
 *
 * The `source` field on `required` discriminates server-side vs client-side
 * enforcement so error messages can credit the right one.
 */
export type SourcingRequirement =
  | { kind: "not_required" }
  | { kind: "skipped"; reason: string }
  | { kind: "required"; source: "server policy" | "client requireSourcing param" };

export function resolveSourcingRequirement(
  c: Context,
  tableName: string,
): SourcingRequirement {
  const serverRequired = SOURCE_CHECK_REQUIRED[tableName] === true;
  const clientRequired = c.req.query("requireSourcing") === "true";

  if (!serverRequired && !clientRequired) return { kind: "not_required" };

  const forceSkip = c.req.query("forceSkipSourcing");
  if (forceSkip === "true") {
    return { kind: "skipped", reason: c.req.query("reason") || "no reason given" };
  }

  return {
    kind: "required",
    source: serverRequired ? "server policy" : "client requireSourcing param",
  };
}

/**
 * Enforce sourcing requirements for a sync endpoint.
 *
 * Checks both the server-side config (SOURCE_CHECK_REQUIRED) and the legacy
 * client-side `?requireSourcing=true` query parameter. If either requests
 * sourcing, all items must include sourcing data.
 *
 * Escape hatch: `?forceSkipSourcing=true&reason=...` bypasses enforcement
 * with an audit log entry. Use for migrations and backfills.
 *
 * @returns A 400 Response if enforcement fails, or null if OK (caller proceeds).
 */
export function enforceSourcing(
  c: Context,
  tableName: string,
  items: Array<{ sourcing?: unknown }>,
): Response | null {
  const req = resolveSourcingRequirement(c, tableName);

  if (req.kind === "not_required") return null;

  if (req.kind === "skipped") {
    logger.warn(
      { table: tableName, itemCount: items.length, reason: req.reason },
      `Source-check enforcement skipped via forceSkipSourcing`,
    );
    return null;
  }

  const unchecked = items.filter((i) => !i.sourcing);
  if (unchecked.length === 0) return null;

  return validationError(
    c,
    `Source-check required (${req.source}) but ${unchecked.length}/${items.length} records lack sourcing data. ` +
    `Run \`pnpm crux tb verify-orchestrate ${tableName}\` to populate source_check_verdicts before submitting, ` +
    `or use ?forceSkipSourcing=true&reason=... to bypass with audit logging.`,
  );
}
