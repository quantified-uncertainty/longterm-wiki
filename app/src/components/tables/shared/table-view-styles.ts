/**
 * Table View Style Configuration
 *
 * Badge colors and utilities for table views (architecture scenarios, deployment architectures, accident risks).
 * Uses Tailwind classes with dark mode support.
 */

// Abstraction levels (accident risks)
export const abstractionColors: Record<string, string> = {
  theoretical: "bg-purple-200 text-purple-800 dark:bg-purple-800 dark:text-purple-200",
  mechanism: "bg-cyan-200 text-cyan-800 dark:bg-cyan-700 dark:text-cyan-100",
  behavior: "bg-amber-200 text-amber-800 dark:bg-amber-700 dark:text-amber-100",
  outcome: "bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200",
};

// Evidence levels
export const evidenceColors: Record<string, string> = {
  theoretical: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  speculative: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
  demonstrated_lab: "bg-green-200 text-green-800 dark:bg-green-700 dark:text-green-100",
  observed_current: "bg-green-500 text-white dark:bg-green-600",
};

// Timeline levels
export const timelineColors: Record<string, string> = {
  current: "bg-red-500 text-white dark:bg-red-600",
  near_term: "bg-orange-400 text-orange-900 dark:bg-orange-600 dark:text-orange-100",
  medium_term: "bg-yellow-200 text-yellow-800 dark:bg-yellow-700 dark:text-yellow-100",
  long_term: "bg-indigo-200 text-indigo-800 dark:bg-indigo-700 dark:text-indigo-100",
  uncertain: "bg-slate-300 text-slate-700 dark:bg-slate-600 dark:text-slate-300",
};

// Severity levels
export const severityColors: Record<string, string> = {
  low: "bg-green-200 text-green-800 dark:bg-green-700 dark:text-green-100",
  medium: "bg-yellow-200 text-yellow-800 dark:bg-yellow-700 dark:text-yellow-100",
  high: "bg-orange-400 text-orange-900 dark:bg-orange-600 dark:text-orange-100",
  catastrophic: "bg-red-600 text-white dark:bg-red-600",
  existential: "bg-red-900 text-white font-bold dark:bg-red-800",
};

// Detectability levels
export const detectabilityColors: Record<string, string> = {
  easy: "bg-green-500 text-white dark:bg-green-600",
  moderate: "bg-yellow-200 text-yellow-800 dark:bg-yellow-700 dark:text-yellow-100",
  difficult: "bg-orange-400 text-orange-900 dark:bg-orange-600 dark:text-orange-100",
  very_difficult: "bg-red-600 text-white dark:bg-red-600",
  unknown: "bg-slate-300 text-slate-700 dark:bg-slate-600 dark:text-slate-300",
};

// Safety outlook
export const safetyOutlookColors: Record<string, string> = {
  favorable: "bg-green-200 text-green-800 border border-green-400 dark:bg-green-700 dark:text-green-100 dark:border-green-600",
  mixed: "bg-amber-200 text-amber-800 border border-amber-400 dark:bg-amber-700 dark:text-amber-100 dark:border-amber-600",
  challenging: "bg-red-200 text-red-800 border border-red-400 dark:bg-red-700 dark:text-red-100 dark:border-red-600",
  unknown: "bg-slate-100 text-slate-600 border border-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:border-slate-600",
};

// Relationship types (accident risks)
export const relationshipColors: Record<string, string> = {
  requires: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  enables: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  overlaps: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  "manifestation-of": "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  "special-case-of": "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
};

// Generic level badges (HIGH/MEDIUM/LOW/PARTIAL/etc)
export const levelColors: Record<string, string> = {
  high: "bg-green-200 text-green-800 dark:bg-green-700 dark:text-green-100",
  "medium-high": "bg-lime-200 text-lime-800 dark:bg-lime-700 dark:text-lime-100",
  medium: "bg-amber-200 text-amber-800 dark:bg-amber-700 dark:text-amber-100",
  "low-med": "bg-amber-200 text-amber-800 dark:bg-amber-700 dark:text-amber-100",
  "low-medium": "bg-amber-200 text-amber-800 dark:bg-amber-700 dark:text-amber-100",
  low: "bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200",
  partial: "bg-indigo-200 text-indigo-800 dark:bg-indigo-700 dark:text-indigo-100",
  complex: "bg-indigo-200 text-indigo-800 dark:bg-indigo-700 dark:text-indigo-100",
  different: "bg-purple-200 text-purple-800 dark:bg-purple-700 dark:text-purple-100",
  hybrid: "bg-purple-200 text-purple-800 dark:bg-purple-700 dark:text-purple-100",
  minimal: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  variable: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
  none: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  "n/a": "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  unknown: "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
  "???": "bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
};

// Adoption levels
export const adoptionColors: Record<string, string> = {
  declining: "bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200",
  low: "bg-amber-200 text-amber-800 dark:bg-amber-700 dark:text-amber-100",
  "low-medium": "bg-amber-200 text-amber-800 dark:bg-amber-700 dark:text-amber-100",
  medium: "bg-blue-200 text-blue-800 dark:bg-blue-700 dark:text-blue-100",
  high: "bg-blue-400 text-blue-900 dark:bg-blue-600 dark:text-blue-100",
};

// Timeline badge
export const timelineBadgeColors: Record<string, string> = {
  "now": "bg-purple-200 text-purple-800 dark:bg-purple-800 dark:text-purple-200",
  "now (legacy)": "bg-slate-300 text-slate-700 dark:bg-slate-600 dark:text-slate-300",
  "now (declining)": "bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200",
  "now - ongoing": "bg-purple-200 text-purple-800 dark:bg-purple-800 dark:text-purple-200",
  "now - 2027": "bg-purple-200 text-purple-800 dark:bg-purple-800 dark:text-purple-200",
  "now - 2030": "bg-purple-200 text-purple-800 dark:bg-purple-800 dark:text-purple-200",
  "now - ???": "bg-purple-200 text-purple-800 dark:bg-purple-800 dark:text-purple-200",
  "now - expanding": "bg-green-200 text-green-800 dark:bg-green-700 dark:text-green-100",
  "research stage": "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
};

// Likelihood badge
export const likelihoodColors = "bg-blue-200 text-blue-800 dark:bg-blue-700 dark:text-blue-100";

// Category colors (architecture scenarios)
export const categoryColors: Record<string, { dot: string; bg: string; text: string }> = {
  deployment: { dot: "bg-blue-500", bg: "bg-blue-50 dark:bg-blue-950", text: "text-blue-700 dark:text-blue-300" },
  "base-arch": { dot: "bg-purple-500", bg: "bg-purple-50 dark:bg-purple-950", text: "text-purple-700 dark:text-purple-300" },
  "alt-compute": { dot: "bg-amber-500", bg: "bg-amber-50 dark:bg-amber-950", text: "text-amber-700 dark:text-amber-300" },
  "non-ai": { dot: "bg-emerald-500", bg: "bg-emerald-50 dark:bg-emerald-950", text: "text-emerald-700 dark:text-emerald-300" },
};

// Risk category colors (accident risks)
export const riskCategoryColors: Record<string, string> = {
  "Theoretical Frameworks": "#7c3aed",
  "Alignment Failures": "#dc2626",
  "Specification Problems": "#f59e0b",
  "Deceptive Behaviors": "#991b1b",
  "Instrumental Behaviors": "#ea580c",
  "Capability Concerns": "#0891b2",
  "Catastrophic Scenarios": "#7f1d1d",
  "Human-AI Interaction": "#4f46e5",
};

// Column group colors for toggle buttons
export const columnGroupColors: Record<string, { inactive: string; active: string }> = {
  overview: {
    inactive: "border-emerald-400 text-emerald-700 dark:border-emerald-600 dark:text-emerald-400",
    active: "bg-emerald-500 text-white border-emerald-500 dark:bg-emerald-600 dark:border-emerald-600",
  },
  safety: {
    inactive: "border-amber-400 text-amber-700 dark:border-amber-600 dark:text-amber-400",
    active: "bg-amber-500 text-white border-amber-500 dark:bg-amber-600 dark:border-amber-600",
  },
  landscape: {
    inactive: "border-sky-400 text-sky-700 dark:border-sky-600 dark:text-sky-400",
    active: "bg-sky-500 text-white border-sky-500 dark:bg-sky-600 dark:border-sky-600",
  },
  assessment: {
    inactive: "border-pink-400 text-pink-700 dark:border-pink-600 dark:text-pink-400",
    active: "bg-pink-500 text-white border-pink-500 dark:bg-pink-600 dark:border-pink-600",
  },
  level: {
    inactive: "border-indigo-400 text-indigo-700 dark:border-indigo-600 dark:text-indigo-400",
    active: "bg-indigo-500 text-white border-indigo-500 dark:bg-indigo-600 dark:border-indigo-600",
  },
  evidence: {
    inactive: "border-green-400 text-green-700 dark:border-green-600 dark:text-green-400",
    active: "bg-green-500 text-white border-green-500 dark:bg-green-600 dark:border-green-600",
  },
  relations: {
    inactive: "border-purple-400 text-purple-700 dark:border-purple-600 dark:text-purple-400",
    active: "bg-purple-500 text-white border-purple-500 dark:bg-purple-600 dark:border-purple-600",
  },
};

/**
 * Get badge color class for a level string
 */
export function getBadgeClass(level: string, category?: string): string {
  const l = level.toLowerCase().replace(/_/g, "-").replace(/ /g, "-");

  // Check category-specific colors first
  if (category) {
    switch (category) {
      case "abstraction":
        if (abstractionColors[l]) return abstractionColors[l];
        break;
      case "evidence":
        if (evidenceColors[l]) return evidenceColors[l];
        break;
      case "timeline":
        if (timelineColors[l]) return timelineColors[l];
        break;
      case "severity":
        if (severityColors[l]) return severityColors[l];
        break;
      case "detectability":
        if (detectabilityColors[l]) return detectabilityColors[l];
        break;
      case "safetyOutlook":
        if (safetyOutlookColors[l]) return safetyOutlookColors[l];
        break;
      case "relationship":
        if (relationshipColors[l]) return relationshipColors[l];
        break;
      case "adoption":
        if (adoptionColors[l]) return adoptionColors[l];
        break;
    }
  }

  // Check generic level colors
  if (levelColors[l]) return levelColors[l];

  // Check for partial matches
  for (const [key, value] of Object.entries(levelColors)) {
    if (l.includes(key)) return value;
  }

  // Fallback
  return "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200";
}

/**
 * Get safety outlook badge class
 */
export function getSafetyOutlookClass(rating: string): string {
  const l = rating.toLowerCase();
  return safetyOutlookColors[l] || safetyOutlookColors.unknown;
}

// Sorting order maps
export const levelSortOrder: Record<string, number> = {
  // Generic levels (higher = better)
  high: 4,
  "medium-high": 3.5,
  medium: 3,
  "low-med": 2.5,
  "low-medium": 2.5,
  low: 2,
  minimal: 1.5,
  partial: 2.5,
  complex: 2,
  different: 2,
  hybrid: 2.5,
  variable: 2,
  none: 0,
  "n/a": 0,
  unknown: 0,
  "???": 0,
  // Abstraction level
  theoretical: 1,
  mechanism: 2,
  behavior: 3,
  outcome: 4,
  // Evidence level
  speculative: 1,
  demonstrated_lab: 3,
  observed_current: 4,
  // Timeline
  long_term: 1,
  medium_term: 2,
  near_term: 3,
  current: 4,
  uncertain: 0,
  // Severity
  catastrophic: 4,
  existential: 5,
  // Detectability (reversed - easy is better)
  easy: 4,
  moderate: 3,
  difficult: 2,
  very_difficult: 1,
  // Safety outlook
  favorable: 4,
  mixed: 3,
  challenging: 2,
};

export function getLevelSortValue(level: string): number {
  const l = level.toLowerCase().replace(/_/g, "-").replace(/ /g, "-");
  if (levelSortOrder[l] !== undefined) return levelSortOrder[l];

  // Check for partial matches
  for (const [key, value] of Object.entries(levelSortOrder)) {
    if (l.includes(key)) return value;
  }
  return 0;
}

// Category sort order
export const categorySortOrder: Record<string, number> = {
  deployment: 1,
  "base-arch": 2,
  "alt-compute": 3,
  "non-ai": 4,
};

export function getCategorySortValue(category: string): number {
  return categorySortOrder[category] ?? 99;
}
