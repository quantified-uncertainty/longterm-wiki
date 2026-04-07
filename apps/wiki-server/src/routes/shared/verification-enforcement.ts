import type { Context } from "hono";
import { logger as rootLogger } from "../../logger.js";
import { validationError } from "./utils.js";

const logger = rootLogger.child({ component: "verification-enforcement" });

/**
 * Server-side verification requirements — independent of client params.
 *
 * When a table is listed here as `true`, the sync endpoint requires every
 * record to include inline verification data. This enforcement is server-side
 * and cannot be bypassed by omitting query parameters.
 *
 * Rollout per Discussion #3875: tables are enabled here as they reach Phase 5.
 */
const VERIFICATION_REQUIRED: Record<string, boolean> = {
  // Enable as tables reach Phase 5 hard enforcement:
  // personnel: true,
  // grants: true,
};

/**
 * Enforce verification requirements for a sync endpoint.
 *
 * Checks both the server-side config (VERIFICATION_REQUIRED) and the legacy
 * client-side `?requireVerification=true` query parameter. If either requests
 * verification, all items must include verification data.
 *
 * Escape hatch: `?forceSkipVerification=true&reason=...` bypasses enforcement
 * with an audit log entry. Use for migrations and backfills.
 *
 * @returns A 400 Response if enforcement fails, or null if OK (caller proceeds).
 */
export function enforceVerification(
  c: Context,
  tableName: string,
  items: Array<{ verification?: unknown }>,
): Response | null {
  const serverRequired = VERIFICATION_REQUIRED[tableName] === true;
  const clientRequired = c.req.query("requireVerification") === "true";

  if (!serverRequired && !clientRequired) return null;

  // Escape hatch for migrations/backfills
  const forceSkip = c.req.query("forceSkipVerification");
  if (forceSkip === "true") {
    const reason = c.req.query("reason") || "no reason given";
    logger.warn(
      { table: tableName, itemCount: items.length, reason },
      `Verification enforcement skipped via forceSkipVerification`,
    );
    return null;
  }

  const unverified = items.filter((i) => !i.verification);
  if (unverified.length === 0) return null;

  const source = serverRequired ? "server policy" : "client requireVerification param";
  return validationError(
    c,
    `Verification required (${source}) but ${unverified.length}/${items.length} records lack verification. ` +
    `Run \`pnpm crux tb verify ${tableName}\` before submitting, ` +
    `or use ?forceSkipVerification=true&reason=... to bypass with audit logging.`,
  );
}
