/**
 * Shared "is this evidence row stale?" definition.
 *
 * Lives in a separate file from `sourcing.ts` because both `sourcing.ts`
 * (route handlers) and `recompute-verdict.ts` (called BY `sourcing.ts`)
 * need the helper. Putting it in `sourcing.ts` would create a cycle:
 * sourcing.ts → recompute-verdict.ts → sourcing.ts.
 */

/**
 * The current checker model used by the sourcing pipeline.
 * Evidence rows checked with a different model are flagged as stale.
 * Update this when the pipeline switches to a newer model.
 */
export const CURRENT_CHECKER_MODEL = "claude-haiku-4-5-20251001";

/**
 * True if the row's `checker_model` is missing or differs from
 * `CURRENT_CHECKER_MODEL`. NULL counts as stale because legacy rows
 * predate the column. The QUA-991 aggregation fix uses this to drop
 * stale rows from the headline verdict when at least one fresh row
 * is present.
 */
export function isStaleModel(checkerModel: string | null): boolean {
  if (!checkerModel) return true;
  return checkerModel !== CURRENT_CHECKER_MODEL;
}
