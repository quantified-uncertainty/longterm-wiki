/**
 * Shared constants for the /risks pages.
 *
 * Centralised here so the listing table and detail pages stay in sync.
 */

// ── Risk category ──────────────────────────────────────────────────────

export const RISK_CATEGORY_LABELS: Record<string, string> = {
  accident: "Accident",
  misuse: "Misuse",
  structural: "Structural",
  epistemic: "Epistemic",
};

export const RISK_CATEGORY_COLORS: Record<string, string> = {
  accident:
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  misuse: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  structural:
    "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  epistemic:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
};

// ── Severity ───────────────────────────────────────────────────────────

/**
 * Ordinal ranking for severity values (title-cased, matching the output of
 * `titleCase()` applied to the raw YAML values).
 */
export const SEVERITY_ORDER: Record<string, number> = {
  Low: 1,
  Medium: 2,
  "Medium High": 3,
  High: 4,
  Critical: 5,
  Catastrophic: 6,
};

/** Badge colours keyed by the **raw** (lowercase-hyphenated) severity value. */
export const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  medium:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  "medium-high":
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  high: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  critical:
    "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  catastrophic:
    "bg-red-200 text-red-900 dark:bg-red-900/40 dark:text-red-200",
};

/**
 * Badge colours keyed by the **title-cased** severity value (as displayed in
 * the table rows, which receive title-cased values from `page.tsx`).
 */
export const SEVERITY_COLORS_DISPLAY: Record<string, string> = {
  Low: SEVERITY_COLORS.low,
  Medium: SEVERITY_COLORS.medium,
  "Medium High": SEVERITY_COLORS["medium-high"],
  High: SEVERITY_COLORS.high,
  Critical: SEVERITY_COLORS.critical,
  Catastrophic: SEVERITY_COLORS.catastrophic,
};

// ── Likelihood ─────────────────────────────────────────────────────────

/**
 * Ordinal ranking for likelihood values (title-cased).
 */
export const LIKELIHOOD_ORDER: Record<string, number> = {
  Low: 1,
  "Medium Low": 2,
  Medium: 3,
  "Medium High": 4,
  High: 5,
  "Very High": 6,
};

/** Badge colours keyed by the **title-cased** likelihood value. */
export const LIKELIHOOD_COLORS_DISPLAY: Record<string, string> = {
  Low: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  "Medium Low":
    "bg-lime-100 text-lime-800 dark:bg-lime-900/30 dark:text-lime-300",
  Medium:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  "Medium High":
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  High: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  "Very High":
    "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};
