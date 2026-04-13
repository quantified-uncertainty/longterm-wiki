// Render-layer sanitizer for raw FactBase / stable IDs leaking into visible
// table cell text in `EntityProfileViewer`. See QUA-397.
//
// Complements the write-path fix in apps/wiki-server/src/routes/factbase/facts.ts
// and handles the unfixable case of fact values that ARE stableId CSVs
// (`"founded-by": "sid_a, sid_b, sid_c"`). Pure — unit-tested.

const RAW_ID_PREFIX_STRIP_RE =
  /^\s*(f_[A-Za-z0-9]{8,}|[a-f0-9]{8,12}|[A-Za-z0-9]{10})\s*(?:[—:-]\s*|\s+[—-]\s+)/;

const RAW_F_ID_RE = /\bf_[A-Za-z0-9]{8,}\b/g;
const RAW_SID_RE = /\bsid_[A-Za-z0-9]{10}\b/g;

// Random 10-char FactBase IDs reliably contain upper+lower+digit. Stricter
// than `isAnySid()` so we don't strip legitimate 10-char entity names
// (`Washington`, `Anthropic1`, ...) that miss one of the three classes.
function looksLikeLegacyFactId(id: string): boolean {
  return (
    id.length === 10 &&
    /[0-9]/.test(id) &&
    /[A-Z]/.test(id) &&
    /[a-z]/.test(id)
  );
}

// Column gating on bare-value detection. Legacy hex (8-12) and legacy
// 10-char alnum shapes are too loose to trust content-first — they collide
// with git SHAs, content hashes, and short entity names. The set covers
// both `id` PK columns and explicit `fact_id`/`factId` references.
const FACT_ID_COLUMNS: ReadonlySet<string> = new Set([
  "id", "fact_id", "factId",
]);

const RESOURCE_ID_COLUMNS: ReadonlySet<string> = new Set([
  "id", "resource_id", "resourceId", "stable_id", "stableId",
]);

const LEGACY_HEX_FACT_ID_RE = /^[a-f0-9]{8,12}$/;
const LEGACY_RESOURCE_HEX_RE = /^[a-f0-9]{16}$/;
const CANONICAL_FACT_ID_RE = /^f_[A-Za-z0-9]{8,}$/;

/**
 * True if `value` is a FactBase fact ID whose `/factbase/fact/<id>` URL
 * resolves reliably on prod — canonical `f_...` (any column) or 8-12 char
 * lowercase hex (column-gated). See `isOpaqueLegacyFactId` for the
 * 10-char alnum format which does NOT resolve reliably.
 */
export function isClickableFactId(value: string, columnName: string): boolean {
  if (CANONICAL_FACT_ID_RE.test(value)) return true;
  if (FACT_ID_COLUMNS.has(columnName) && LEGACY_HEX_FACT_ID_RE.test(value)) {
    return true;
  }
  return false;
}

/**
 * True if `value` is a legacy 10-char mixed-case alnum fact ID. The
 * `/factbase/fact/<id>` route resolves these unreliably (measured 2 of 5
 * sample IDs returned 404 on prod 2026-04-13), so the caller should render
 * them as a non-link with the full ID in `title=`. Eliminated by QUA-407
 * Phase 1 (migrate to canonical `f_<10>`).
 */
export function isOpaqueLegacyFactId(value: string, columnName: string): boolean {
  return FACT_ID_COLUMNS.has(columnName) && looksLikeLegacyFactId(value);
}

/** True if `value` is a legacy pre-`sid_` 16-char hex resource stableId. */
export function isLegacyResourceId(value: string, columnName: string): boolean {
  return RESOURCE_ID_COLUMNS.has(columnName) && LEGACY_RESOURCE_HEX_RE.test(value);
}

/**
 * Strip a leading raw-ID prefix (`"f_xxx — "`, `"e7c42d88: "`, etc.) and
 * mask any remaining embedded `f_` / `sid_` with `…`. Returns the input
 * unchanged (same identity, for React memo) when no sanitization applies.
 */
export function sanitizeRawIds(s: string): string {
  // Fast path: most cells contain no raw-ID-shaped text. A single indexOf
  // scan on a short string is cheaper than running three regexes, and
  // returning the input unchanged preserves React's identity check.
  if (
    !s.includes("f_") &&
    !s.includes("sid_") &&
    !RAW_ID_PREFIX_STRIP_RE.test(s)
  ) {
    return s;
  }

  // A successful prefix match means one of the three ID shapes matched —
  // the regex alternatives already enumerated them, no need to re-classify.
  const prefixMatch = s.match(RAW_ID_PREFIX_STRIP_RE);
  const stripped = prefixMatch ? s.slice(prefixMatch[0].length) : s;
  return stripped
    .replace(RAW_F_ID_RE, "\u2026")
    .replace(RAW_SID_RE, "\u2026");
}
