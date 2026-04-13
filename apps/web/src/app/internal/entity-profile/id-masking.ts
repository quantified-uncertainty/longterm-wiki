/**
 * Cell-value ID masking helpers for entity-profile-viewer.
 *
 * Extracted from entity-profile-viewer.tsx so they can be unit-tested without
 * importing React. See QUA-397 for context — this is the third iteration of
 * the raw-ID leak fix (after QUA-316, QUA-346, QUA-354), and the helpers here
 * are deliberately small + tested so the next iteration can extend them
 * without re-discovering the edge cases.
 */

/** Canonical FactBase fact ID: `f_` + 8+ alphanumeric chars (e.g. `f_dW5cR9mJ8q`). */
export const FACT_ID_RE = /^f_[A-Za-z0-9]{8,}$/;

/**
 * Legacy pre-migration fact IDs — bare 8-12 char hex strings (e.g. `e7c42d88`,
 * `f2a06bd3`). These predate the `f_` prefix and are still in the facts table
 * on prod. Matching purely on shape is too permissive to use as a primary
 * detector — many unrelated values (git SHAs, content hashes, short IDs in
 * other tables) share the same shape. Callers must gate this by column name.
 */
export const LEGACY_FACT_ID_RE = /^[a-f0-9]{8,12}$/;

/** Column names where we trust `LEGACY_FACT_ID_RE` to detect fact IDs. */
export const LEGACY_FACT_ID_COLUMNS: ReadonlySet<string> = new Set([
  "fact_id",
  "factId",
]);

/**
 * Legacy pre-migration resource stableIds — bare 16-char hex strings (e.g.
 * `1f21fae8ed666710`). Column-gated for the same reason as fact IDs.
 */
export const LEGACY_RESOURCE_ID_RE = /^[a-f0-9]{16}$/;

/** Column names where we trust `LEGACY_RESOURCE_ID_RE` to detect resource IDs. */
export const LEGACY_RESOURCE_ID_COLUMNS: ReadonlySet<string> = new Set([
  "resource_id",
  "resourceId",
  "stable_id",
  "stableId",
]);

/**
 * Thing titles whose FactBase title resolver fell back to the raw fact ID
 * render as:
 *   - `f_qR5tY9wE1a — Anthropic` (title)
 *   - `f_qR5tY9wE1a: 100000000` (description)
 *   - `e7c42d88: 1000000000` (legacy description)
 *
 * The regex strips the raw-ID prefix so the visible text is just the
 * human-readable remainder. The write path has been fixed (see
 * apps/wiki-server/src/routes/factbase/facts.ts) but existing rows won't
 * rewrite until the next full sync; this render-layer defense masks the
 * stale rows.
 */
const THING_TITLE_WITH_FACT_ID_RE =
  /^(?:f_[A-Za-z0-9]{8,}|[a-f0-9]{8,12})(?: — | : |: )(.+)$/;

/**
 * If `value` begins with a raw fact ID followed by ` — ` or `: `, return just
 * the remainder. Otherwise return `null` (caller should render the value
 * normally). Pure function; safe to test.
 */
export function stripFactIdPrefix(value: string): string | null {
  const m = value.match(THING_TITLE_WITH_FACT_ID_RE);
  return m ? m[1] : null;
}

/**
 * True if `value` is a canonical FactBase fact ID (`f_...`). Content-based,
 * not column-name-gated — the prefix is unique enough to trust.
 */
export function isFactId(value: string): boolean {
  return FACT_ID_RE.test(value);
}

/**
 * True if `value` looks like a legacy pre-migration fact ID AND the column
 * name is in the allowlist. Column-gated on purpose: bare hex strings of this
 * length appear on unrelated columns (git SHAs, content hashes).
 */
export function isLegacyFactId(value: string, columnName: string): boolean {
  return LEGACY_FACT_ID_COLUMNS.has(columnName) && LEGACY_FACT_ID_RE.test(value);
}

/**
 * True if `value` looks like a legacy pre-migration resource stableId AND the
 * column name is in the allowlist.
 */
export function isLegacyResourceId(value: string, columnName: string): boolean {
  return (
    LEGACY_RESOURCE_ID_COLUMNS.has(columnName) && LEGACY_RESOURCE_ID_RE.test(value)
  );
}
