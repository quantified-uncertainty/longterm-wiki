/**
 * Render-layer sanitizer for raw FactBase / stable IDs leaking into visible
 * table cell text in `EntityProfileViewer`. See QUA-397.
 *
 * This is the last line of defense against the recurring raw-ID leak class.
 * Upstream fixes (sync-facts.ts, facts.ts write path, upsertThingsInTx
 * sentinel) prevent NEW bad rows, but existing `things.title` /
 * `things.description` rows written by the old code still contain baked-in
 * raw IDs until the next `sync-facts` backfill runs. This function masks
 * them at render time so the UI is clean immediately on deploy, regardless
 * of backfill timing.
 *
 * It also catches the ref-list value case — facts like `founded-by` serialize
 * their value as a CSV of stableIds (`"sid_a, sid_b, sid_c"`), which the
 * write-path fix does not address (the fact value is valid data, it's the
 * display that needs to resolve it).
 *
 * Pure function — safe to unit test.
 */

/**
 * Matches a leading raw-ID prefix of the form `{id} — ` / `{id}: ` / `{id}-`.
 * Applied first so titles like `"f_xxx — Entity"` render as `"Entity"`
 * rather than `"… — Entity"`.
 */
const RAW_ID_PREFIX_STRIP_RE =
  /^\s*(?:f_[A-Za-z0-9]{8,}|[a-f0-9]{8,12})\s*(?:[—:-]\s*|\s+[—-]\s+)/;

/** Matches any canonical FactBase fact ID embedded in a longer string. */
const RAW_F_ID_RE = /\bf_[A-Za-z0-9]{8,}\b/g;

/** Matches a 10-char stableId embedded in a longer string. */
const RAW_SID_RE = /\bsid_[A-Za-z0-9]{10}\b/g;

/**
 * Sanitizes a cell value for rendering:
 *   1. If the string starts with a raw-ID prefix like `"f_xxx — "` or
 *      `"e7c42d88: "`, strip it so only the human-readable remainder shows.
 *   2. Mask any remaining embedded raw ids with an ellipsis (`…`).
 *
 * Returns the sanitized string. If no sanitization was needed, returns `s`
 * unchanged (same object identity) so React can skip re-rendering.
 */
export function sanitizeRawIds(s: string): string {
  const stripped = s.replace(RAW_ID_PREFIX_STRIP_RE, "");
  const masked = stripped
    .replace(RAW_F_ID_RE, "\u2026")
    .replace(RAW_SID_RE, "\u2026");
  return masked;
}
