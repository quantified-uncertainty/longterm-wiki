/**
 * Shared enums for the QUA-691 frontier-safety-framework tables.
 *
 * Mirror the CHECK allowlists in migration 0206. Imported by:
 *   - tablebase/framework-capability-thresholds.ts
 *   - tablebase/framework-diffs.ts
 *   - tablebase/framework-diff-items.ts
 *   - operational/framework-review.ts
 *
 * Keep these in sync with the SQL CHECK constraints — adding a value here
 * without an ALTER on the constraint will fail at insert time.
 */

export const VALID_RISK_DOMAINS = [
  "cbrn",
  "bio",
  "chem",
  "nuclear",
  "radiological",
  "cyber",
  "autonomy_replication",
  "ai_rd",
  "scheming",
  "persuasion",
  "loss_of_control",
  "other",
] as const;

export const VALID_COMMITMENT_LANGUAGES = [
  "committed",
  "aspirational",
  "conditional",
  "informational",
] as const;

export const VALID_OVERALL_DIRECTIONS = [
  "weaker",
  "stronger",
  "mixed",
  "neutral",
  "rewrite",
] as const;

/**
 * All review verdicts that can appear in `framework_diffs.review_verdict`,
 * including the default `unreviewed` state.
 */
export const VALID_REVIEW_VERDICTS = [
  "confirmed_weakening",
  "confirmed_strengthening",
  "false_positive",
  "nuanced",
  "unreviewed",
] as const;

/**
 * Verdicts the dashboard can apply to a diff. Excludes `unreviewed` —
 * review actions always move a row out of the unreviewed bucket.
 */
export const VALID_DASHBOARD_DIFF_VERDICTS = [
  "confirmed_weakening",
  "confirmed_strengthening",
  "false_positive",
  "nuanced",
] as const;
