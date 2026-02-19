/**
 * Shared grading prompt fragments and constants.
 *
 * Imported by both grading pipelines:
 *   - crux/authoring/creator/grading.ts  (page-creator grading)
 *   - crux/authoring/grading/prompts.ts  (bulk grade-content pipeline)
 */

/**
 * Canonical description of the readerImportance metric for use in LLM prompts.
 * Both grading pipelines score this field; keep the guidelines in one place.
 */
export const READER_IMPORTANCE_GUIDELINES = `READER IMPORTANCE guidelines (how significant for understanding AI risk and prioritization):
- 90-100: Essential for prioritization decisions
- 70-89: High value for practitioners
- 50-69: Useful context
- 30-49: Reference material
- 0-29: Peripheral or stubs`;

/**
 * Canonical description of the tacticalValue metric for use in LLM prompts.
 * Both grading pipelines score this field; keep the guidelines in one place.
 */
export const TACTICAL_VALUE_GUIDELINES = `TACTICAL VALUE guidelines (how urgently does this page need updates when news breaks?):
- 85-100: Changes frequently with news (company/person pages for active labs, policy/governance topics, frontier model comparisons, compute/chip landscape)
- 65-84: Moderately time-sensitive (research org pages, active capability areas, funding landscape, active debates influenced by new models)
- 45-64: Slow-moving (conceptual frameworks, historical analysis, well-established risks)
- 25-44: Very stable (foundational theory, math, philosophical positions)
- 0-24: Evergreen/timeless (core definitions, stable concepts)`;

/**
 * The JSON field declarations for reader importance and tactical value,
 * used inside the "Respond with JSON" block of both pipelines.
 */
export const GRADED_SCORE_JSON_FIELDS = `  "readerImportance": <0-100>,
  "tacticalValue": <0-100, integer>,`;
