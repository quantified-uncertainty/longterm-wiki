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
 *
 * Three ID shapes are stripped as a prefix:
 *   1. `f_` + 8+ alphanumeric chars (canonical post-migration FactBase fact IDs)
 *   2. 8-12 lowercase hex (pre-migration legacy fact IDs, e.g. `e7c42d88`)
 *   3. 10-char mixed-case alphanumeric (pre-`f_` legacy FactBase IDs, e.g.
 *      `2Y4ope8OxA`, `XUSIG6vsPw`). The 10-char alnum pattern is too loose
 *      to trust on its own, so `sanitizeRawIds()` adds an entropy gate
 *      (requires uppercase + lowercase + digit) before treating it as an ID.
 */
const RAW_ID_PREFIX_STRIP_RE =
  /^\s*(f_[A-Za-z0-9]{8,}|[a-f0-9]{8,12}|[A-Za-z0-9]{10})\s*(?:[—:-]\s*|\s+[—-]\s+)/;

/** Matches any canonical FactBase fact ID embedded in a longer string. */
const RAW_F_ID_RE = /\bf_[A-Za-z0-9]{8,}\b/g;

/** Matches a 10-char stableId embedded in a longer string. */
const RAW_SID_RE = /\bsid_[A-Za-z0-9]{10}\b/g;

/**
 * Entropy gate for the 10-char mixed-case prefix alternative. Random FactBase
 * IDs reliably contain at least one uppercase letter, one lowercase letter,
 * and one digit. Legitimate 10-char entity names (e.g. `"Washington"`,
 * `"Anthropic1"` — also rare) typically fail at least one of these checks.
 * This avoids stripping real text that happens to be exactly 10 chars.
 */
function looksLikeLegacyFactId(id: string): boolean {
  return (
    id.length === 10 &&
    /[0-9]/.test(id) &&
    /[A-Z]/.test(id) &&
    /[a-z]/.test(id)
  );
}

// ── Column-gated bare-value detection ──────────────────────────────────
//
// These helpers detect raw IDs sitting alone in a cell (not as a prefix).
// They are column-name-gated so bare-hex strings in unrelated columns
// (git SHAs, content hashes, numeric strings) don't produce false positives.
// See QUA-397 for the leak inventory.

/** Columns where we trust a bare 10-char alphanumeric to be a legacy FactBase fact ID. */
const LEGACY_FACT_ID_COLUMNS: ReadonlySet<string> = new Set([
  "id", "fact_id", "factId",
]);

/** Columns where we trust 8-12 char lowercase hex to be a legacy fact ID. */
const LEGACY_HEX_FACT_ID_COLUMNS: ReadonlySet<string> = new Set([
  "id", "fact_id", "factId",
]);

/** Columns where we trust a 16-char lowercase hex to be a legacy resource ID. */
const LEGACY_RESOURCE_ID_COLUMNS: ReadonlySet<string> = new Set([
  "id", "resource_id", "resourceId", "stable_id", "stableId",
]);

const LEGACY_HEX_FACT_ID_RE = /^[a-f0-9]{8,12}$/;
const LEGACY_RESOURCE_HEX_RE = /^[a-f0-9]{16}$/;
const CANONICAL_FACT_ID_RE = /^f_[A-Za-z0-9]{8,}$/;

/**
 * True if `value` is a FactBase fact ID — canonical (`f_...`), 8-12 lowercase
 * hex (legacy format A), or 10-char mixed-case alphanumeric (legacy format B).
 * The non-canonical forms are column-name-gated because their shape is too
 * loose to trust alone.
 */
export function isAnyFactId(value: string, columnName: string): boolean {
  if (CANONICAL_FACT_ID_RE.test(value)) return true;
  if (LEGACY_HEX_FACT_ID_COLUMNS.has(columnName) && LEGACY_HEX_FACT_ID_RE.test(value)) {
    return true;
  }
  if (LEGACY_FACT_ID_COLUMNS.has(columnName) && looksLikeLegacyFactId(value)) {
    return true;
  }
  return false;
}

/**
 * True if `value` is a legacy pre-`sid_` resource stableId (16 hex chars) in
 * a column where we trust that shape.
 */
export function isLegacyResourceId(value: string, columnName: string): boolean {
  return LEGACY_RESOURCE_ID_COLUMNS.has(columnName) && LEGACY_RESOURCE_HEX_RE.test(value);
}

/**
 * Sanitizes a cell value for rendering:
 *   1. If the string starts with a raw-ID prefix like `"f_xxx — "` or
 *      `"e7c42d88: "` or `"2Y4ope8OxA — "`, strip it so only the
 *      human-readable remainder shows.
 *   2. Mask any remaining embedded raw ids with an ellipsis (`…`).
 *
 * Returns the sanitized string. If no sanitization was needed, returns `s`
 * unchanged (same object identity) so React can skip re-rendering.
 */
export function sanitizeRawIds(s: string): string {
  let stripped = s;
  const match = s.match(RAW_ID_PREFIX_STRIP_RE);
  if (match) {
    const id = match[1];
    const isCanonical = id.startsWith("f_");
    const isLowerHex = /^[a-f0-9]{8,12}$/.test(id);
    const isLegacyMixed = looksLikeLegacyFactId(id);
    if (isCanonical || isLowerHex || isLegacyMixed) {
      stripped = s.slice(match[0].length);
    }
  }
  const masked = stripped
    .replace(RAW_F_ID_RE, "\u2026")
    .replace(RAW_SID_RE, "\u2026");
  return masked;
}
