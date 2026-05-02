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

const HEADER_BUDGET_CHARS = 8_000;
const SEPARATOR = "\n\n[... omitted: middle of source document ...]\n\n";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the start position of the dimension's deep section in `sourceText`.
 *
 * Recognized patterns (most specific first, since FLI's "X This domain"
 * phrasing is the strongest signal):
 *   - `<Dimension> This domain` — FLI AI Safety Index page format
 *   - `<Dimension> This area` / `This category` — defensive variants
 *   - `<Dimension> evaluates` / `<Dimension> covers` / `<Dimension> assesses`
 *     — phrasing common on other scorecard pages and the "X This domain
 *     evaluates ..." opener
 *
 * The match must occur past `minPos` (the header budget) so we do not
 * accidentally re-anchor on the early dimensions list (which is just
 * labels with no per-org grades).
 *
 * Returns -1 if no match.
 */
export function findDimensionSection(
  sourceText: string,
  dimensionLabel: string,
  minPos: number,
): number {
  if (!dimensionLabel) return -1;
  const escaped = escapeRegExp(dimensionLabel);
  // Global flag so .matchAll() yields *every* occurrence — we need to skip
  // matches in the early TOC/labels list (before minPos) and return the
  // first one in the deep section.
  const patterns: RegExp[] = [
    new RegExp(`${escaped}\\s+This\\s+(domain|area|category)`, "gi"),
    new RegExp(`${escaped}\\s+(evaluates|covers|assesses|measures|examines)`, "gi"),
  ];
  for (const re of patterns) {
    for (const m of sourceText.matchAll(re)) {
      if (m.index !== undefined && m.index >= minPos) return m.index;
    }
  }
  return -1;
}

/**
 * Build a focused excerpt for a `scorecard_grade` row. Returns at most
 * `maxLength` chars. See module docstring for the rationale.
 *
 * - For "Overall" rows (or rows with no dimension), returns the first
 *   `maxLength` chars unchanged.
 * - For per-dimension rows where the deep section is found, returns
 *   `header (~8K) + separator + window starting at the deep section`.
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

  const dimensionRaw = fields.dimension;
  const dimension =
    typeof dimensionRaw === "string" ? dimensionRaw.trim() : "";

  // Early/overall rows: the main scorecard table sits in the first window,
  // so the existing slice already shows what's needed.
  if (!dimension || dimension.toLowerCase() === "overall") {
    return sourceText.slice(0, maxLength);
  }

  const deepStart = findDimensionSection(
    sourceText,
    dimension,
    HEADER_BUDGET_CHARS,
  );
  if (deepStart < 0) {
    return sourceText.slice(0, maxLength);
  }

  const header = sourceText.slice(0, HEADER_BUDGET_CHARS);
  const remainingBudget = maxLength - header.length - SEPARATOR.length;
  if (remainingBudget <= 0) {
    // Pathological: maxLength smaller than header budget. Just return
    // first maxLength.
    return sourceText.slice(0, maxLength);
  }

  const deepEnd = Math.min(sourceText.length, deepStart + remainingBudget);
  return header + SEPARATOR + sourceText.slice(deepStart, deepEnd);
}
