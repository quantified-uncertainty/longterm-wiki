/**
 * Domain-aware excerpt extraction for `scorecard_grade` sourcing (QUA-978).
 *
 * Long scorecard pages (FLI AI Safety Index, FMTI report, etc.) lay out
 * per-domain breakdown tables sequentially: an early "main scorecard" with
 * each org's overall grade, then a deep section per dimension that contains
 * the per-dimension grades for every org. The deep sections frequently sit
 * past the 30K-char prompt window — so the LLM only ever sees the overall
 * grades and incorrectly flags every per-dimension claim as `contradicted`
 * (the comparison the LLM performs is "claimed D on Existential Safety vs
 * visible C+ overall — those don't match"). The published per-dimension
 * grade *is* in the source, just past where we were slicing.
 *
 * Strategy: when verifying a `scorecard_grade` row whose dimension is not
 * "Overall", locate the dimension's deep section in the source text and
 * build a focused excerpt that includes (a) the early "main scorecard"
 * (so the entity's overall grade is visible for cross-reference) and
 * (b) a window centered on the dimension's deep section.
 *
 * For "Overall" rows or when no dimension-deep section can be found, we
 * fall back to the unchanged "first N chars" behavior.
 */

const SEPARATOR = "\n\n[... omitted: middle of source document ...]\n\n";
/**
 * Maximum permitted dimension label length. Defends against pathological
 * data-layer values that would inflate the regex pattern. Real scorecard
 * dimension labels are short ("Risk Assessment", "Indicator 4.3
 * (regulatory)", etc.); 200 chars is comfortably above any real publisher.
 */
const MAX_DIMENSION_LABEL_LEN = 200;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the start position of the dimension's deep section in `sourceText`.
 *
 * Recognized phrasings (run as a single alternation; we return the
 * earliest match across all variants past `minPos`, so pattern listing
 * order does not bias the result toward a later text position):
 *   - `<Dimension> This domain` — FLI AI Safety Index page format
 *   - `<Dimension> This area` / `This category` — defensive variants
 *   - `<Dimension> evaluates` / `<Dimension> covers` / `<Dimension>
 *     assesses` / `... measures` / `... examines` — phrasing common on
 *     other scorecard pages and the "X This domain evaluates ..." opener
 *
 * The match must occur past `minPos` (typically the header budget) so we
 * do not accidentally re-anchor on the early dimensions list (which is
 * just labels with no per-org grades). It must also be preceded by a
 * non-word character or start-of-text, so a dimension like "Safety" does
 * not cross-anchor onto another org's "AI Safety This domain" section.
 *
 * Returns -1 if no match, or if `dimensionLabel` is empty / oversized.
 */
export function findDimensionSection(
  sourceText: string,
  dimensionLabel: string,
  minPos: number,
): number {
  if (!dimensionLabel) return -1;
  if (dimensionLabel.length > MAX_DIMENSION_LABEL_LEN) return -1;
  const escaped = escapeRegExp(dimensionLabel);
  // Single combined pattern — let the regex engine return matches in
  // text order, then we pick the first one past minPos. Earlier
  // implementations iterated patterns sequentially and returned the
  // first hit of the first pattern, which would skip an earlier deep
  // section anchored by a later pattern.
  //
  // Lookbehind `(?<=^|[^A-Za-z0-9_])` requires a non-word char (or
  // start-of-text) before the dimension label, preventing cross-org
  // false matches like `dimensionLabel='Safety'` matching inside
  // `"AI Safety This domain..."`.
  const re = new RegExp(
    `(?<=^|[^A-Za-z0-9_])${escaped}\\s+(?:This\\s+(?:domain|area|category)|evaluates|covers|assesses|measures|examines)`,
    "gi",
  );
  for (const m of sourceText.matchAll(re)) {
    if (m.index !== undefined && m.index >= minPos) return m.index;
  }
  return -1;
}

/**
 * Pick the header budget for `buildScorecardGradeExcerpt`. Caps at 8K
 * (covers the typical "main scorecard table" preamble on every observed
 * publisher) but never claims more than a quarter of the prompt window
 * — so a future tuning that drops `PROMPT_CONTENT_LENGTH` to, say, 10K
 * still leaves room for the deep-section window.
 */
function chooseHeaderBudget(maxLength: number): number {
  return Math.min(8_000, Math.floor(maxLength / 4));
}

/**
 * Build a focused excerpt for a `scorecard_grade` row. Returns at most
 * `maxLength` chars. See module docstring for the rationale.
 *
 * - For "Overall" rows (or rows with no dimension), returns the first
 *   `maxLength` chars unchanged.
 * - For per-dimension rows where the deep section is found, returns
 *   `header + separator + window starting at the deep section`.
 * - For per-dimension rows where the deep section is not found, falls
 *   back to the first `maxLength` chars (preserving today's behavior;
 *   the verdict will be `contradicted` or `unverifiable` as before).
 */
export function buildScorecardGradeExcerpt(
  fields: Record<string, string | number | null>,
  sourceText: string,
  maxLength: number,
): string {
  if (sourceText.length <= maxLength) return sourceText;

  // Dimension is typed `Record<string, string | number | null>` to match
  // the upstream `RecordItemData['fields']` shape. Coerce numbers to
  // string so a publisher whose dimension labels are numeric (e.g. FMTI's
  // "4.3" indicators) still routes through the deep-section lookup.
  const dimensionRaw = fields.dimension;
  const dimension =
    typeof dimensionRaw === "string"
      ? dimensionRaw.trim()
      : typeof dimensionRaw === "number" && Number.isFinite(dimensionRaw)
        ? String(dimensionRaw)
        : "";

  // Early/overall rows: the main scorecard table sits in the first
  // window, so the existing slice already shows what's needed.
  // `startsWith("overall")` accepts "Overall", "Overall Grade",
  // "Overall Score", etc. Trim happens above.
  if (!dimension || dimension.toLowerCase().startsWith("overall")) {
    return sourceText.slice(0, maxLength);
  }

  const headerBudget = chooseHeaderBudget(maxLength);
  const deepStart = findDimensionSection(sourceText, dimension, headerBudget);
  if (deepStart < 0) {
    return sourceText.slice(0, maxLength);
  }

  const remainingBudget = maxLength - headerBudget - SEPARATOR.length;
  if (remainingBudget <= 0) {
    // Pathological: maxLength too small to fit header + separator + any
    // deep-section content. Fall back to the simple slice.
    return sourceText.slice(0, maxLength);
  }

  const header = sourceText.slice(0, headerBudget);
  const deepEnd = Math.min(sourceText.length, deepStart + remainingBudget);
  return header + SEPARATOR + sourceText.slice(deepStart, deepEnd);
}
