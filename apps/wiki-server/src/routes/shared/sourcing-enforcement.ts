import type { Context, TypedResponse } from "hono";
import { logger as rootLogger } from "../../logger.js";
import { validationError, VALIDATION_ERROR } from "./utils.js";

/**
 * Concrete TypedResponse shape returned on enforcement failure. Declared so
 * Hono RPC routes that wire `enforceSourcing` directly (rather than going
 * through `sync-factory`) keep their `InferResponseType<..., 200>` narrowed
 * to the success branch — without this, the bare `Response | null` return
 * type collapses the route's response inference to `{}`.
 */
export type EnforceSourcingError = Response &
  TypedResponse<
    { error: typeof VALIDATION_ERROR; message: string },
    400,
    "json"
  >;

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
  // QUA-852 / QUA-729 Phase C: enabled 2026-05-01.
  // Gate: checkable-fact coverage 93.7% (1841 verdicts / 1964 checkable facts);
  // QUA-928 split the metric so this is measured against the checkable subset
  // (facts with a source URL on a `verifiable: true` property), not all-facts.
  //
  // **Scope of enforcement.** Today the only existing /api/facts/sync caller
  // is `crux/wiki-server/sync-facts.ts` (the CI bulk YAML re-sync), which
  // hard-codes `?forceSkipSourcing=true&reason=...`. So this gate is *not*
  // an enforcement against the bulk path — it is a tripwire for any future
  // ad-hoc /sync POSTs (manual curl, new dashboards, third-party tooling).
  // Real per-fact sourcing pressure is enforced upstream at fact-creation
  // time by `crux fb add-fact`, which now requires `--source=URL` for facts
  // on verifiable properties. The bulk path bypasses because ~33% of facts
  // are non-checkable by design (`verifiable: false` properties or
  // legitimately have no source URL) and carry no verdict to attach inline.
  fact: true,
};

/**
 * Resolve whether sourcing is required for this request, given the route's
 * table name and the request's query params. Used internally by
 * {@link enforceSourcing}; exported for direct unit testing.
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
 * Emit the audit-log warning for the `?forceSkipSourcing=true` escape hatch.
 * Used internally by {@link enforceSourcing}.
 *
 * Returns silently if `req.kind !== "skipped"`.
 */
export function logSourcingSkipped(
  tableName: string,
  itemCount: number,
  req: SourcingRequirement,
): void {
  if (req.kind !== "skipped") return;
  logger.warn(
    { table: tableName, itemCount, reason: req.reason },
    `Source-check enforcement skipped via forceSkipSourcing`,
  );
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
): EnforceSourcingError | null {
  const req = resolveSourcingRequirement(c, tableName);

  if (req.kind === "not_required") return null;

  if (req.kind === "skipped") {
    logSourcingSkipped(tableName, items.length, req);
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
