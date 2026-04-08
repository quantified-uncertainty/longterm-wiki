import type { Context } from "hono";
import { logger as rootLogger } from "../../logger.js";
import { validationError } from "./utils.js";

const logger = rootLogger.child({ component: "source-check-enforcement" });

/**
 * Server-side source-check requirements — independent of client params.
 *
 * When a table is listed here as `true`, the sync endpoint requires every
 * record to include inline source-check data. This enforcement is server-side
 * and cannot be bypassed by omitting query parameters.
 *
 * Rollout per Discussion #3875: tables are enabled here as they reach Phase 5.
 */
const SOURCE_CHECK_REQUIRED: Record<string, boolean> = {
  // Enable as tables reach Phase 5 hard enforcement:
  // personnel: true,
  // grants: true,
};

/**
 * Enforce source-check requirements for a sync endpoint.
 *
 * Checks both the server-side config (SOURCE_CHECK_REQUIRED) and the legacy
 * client-side `?requireSourceCheck=true` query parameter. If either requests
 * source-check, all items must include source-check data.
 *
 * Escape hatch: `?forceSkipSourceCheck=true&reason=...` bypasses enforcement
 * with an audit log entry. Use for migrations and backfills.
 *
 * @returns A 400 Response if enforcement fails, or null if OK (caller proceeds).
 */
export function enforceSourceCheck(
  c: Context,
  tableName: string,
  items: Array<{ sourcing?: unknown }>,
): Response | null {
  const serverRequired = SOURCE_CHECK_REQUIRED[tableName] === true;
  const clientRequired = c.req.query("requireSourceCheck") === "true";

  if (!serverRequired && !clientRequired) return null;

  // Escape hatch for migrations/backfills
  const forceSkip = c.req.query("forceSkipSourceCheck");
  if (forceSkip === "true") {
    const reason = c.req.query("reason") || "no reason given";
    logger.warn(
      { table: tableName, itemCount: items.length, reason },
      `Source-check enforcement skipped via forceSkipSourceCheck`,
    );
    return null;
  }

  const unchecked = items.filter((i) => !i.sourcing);
  if (unchecked.length === 0) return null;

  const source = serverRequired ? "server policy" : "client requireSourceCheck param";
  return validationError(
    c,
    `Source-check required (${source}) but ${unchecked.length}/${items.length} records lack source-check data. ` +
    `Run \`pnpm crux tb verify ${tableName}\` before submitting, ` +
    `or use ?forceSkipSourceCheck=true&reason=... to bypass with audit logging.`,
  );
}
