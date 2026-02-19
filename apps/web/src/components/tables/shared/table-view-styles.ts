/**
 * Table View Style Configuration
 *
 * Badge colors and utilities for all table views.
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

// Adoption levels (generic tables)
export const adoptionColors: Record<string, string> = {
  declining: "bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200",
  low: "bg-amber-200 text-amber-800 dark:bg-amber-700 dark:text-amber-100",
  "low-medium": "bg-amber-200 text-amber-800 dark:bg-amber-700 dark:text-amber-100",
  medium: "bg-blue-200 text-blue-800 dark:bg-blue-700 dark:text-blue-100",
  high: "bg-blue-400 text-blue-900 dark:bg-blue-600 dark:text-blue-100",
  // Safety-specific adoption levels
  experimental: "bg-purple-200 text-purple-800 dark:bg-purple-800 dark:text-purple-200",
  widespread: "bg-blue-400 text-blue-900 dark:bg-blue-600 dark:text-blue-100",
  universal: "bg-blue-600 text-white dark:bg-blue-700",
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

// Safety category colors (safety approaches)
export const safetyCategoryColors: Record<string, { dot: string; border: string }> = {
  training: { dot: "bg-blue-500", border: "border-blue-300 dark:border-blue-700" },
  interpretability: { dot: "bg-purple-500", border: "border-purple-300 dark:border-purple-700" },
  evaluation: { dot: "bg-amber-500", border: "border-amber-300 dark:border-amber-700" },
  architectural: { dot: "bg-green-500", border: "border-green-300 dark:border-green-700" },
  governance: { dot: "bg-slate-500", border: "border-slate-300 dark:border-slate-700" },
  theoretical: { dot: "bg-pink-500", border: "border-pink-300 dark:border-pink-700" },
};

// Safety category sort order
export const safetyCategorySortOrder: Record<string, number> = {
  training: 1,
  interpretability: 2,
  evaluation: 3,
  architectural: 4,
  governance: 5,
  theoretical: 6,
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
  signal: {
    inactive: "border-cyan-400 text-cyan-700 dark:border-cyan-600 dark:text-cyan-400",
    active: "bg-cyan-500 text-white border-cyan-500 dark:bg-cyan-600 dark:border-cyan-600",
  },
  risk: {
    inactive: "border-red-400 text-red-700 dark:border-red-600 dark:text-red-400",
    active: "bg-red-500 text-white border-red-500 dark:bg-red-600 dark:border-red-600",
  },
  strategy: {
    inactive: "border-violet-400 text-violet-700 dark:border-violet-600 dark:text-violet-400",
    active: "bg-violet-500 text-white border-violet-500 dark:bg-violet-600 dark:border-violet-600",
  },
};

// --- Safety-specific color maps (merged from safety-table-styles.ts) ---

// Safety uplift levels (higher = better)
export const safetyUpliftColors: Record<string, string> = {
  critical: "bg-green-800 text-white dark:bg-green-700",
  high: "bg-green-500 text-white dark:bg-green-600",
  medium: "bg-lime-400 text-lime-900 dark:bg-lime-600 dark:text-lime-100",
  low: "bg-yellow-200 text-yellow-800 dark:bg-yellow-700 dark:text-yellow-100",
  "low-medium": "bg-yellow-300 text-yellow-900 dark:bg-yellow-600 dark:text-yellow-100",
  negligible: "bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200",
};

// Capability uplift levels (higher = worse for safety)
export const capabilityUpliftColors: Record<string, string> = {
  dominant: "bg-red-800 text-white dark:bg-red-700",
  significant: "bg-red-500 text-white dark:bg-red-600",
  "significant-cap": "bg-red-500 text-white dark:bg-red-600",
  some: "bg-orange-400 text-orange-900 dark:bg-orange-600 dark:text-orange-100",
  neutral: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  tax: "bg-green-300 text-green-900 dark:bg-green-700 dark:text-green-100",
  negative: "bg-green-500 text-white dark:bg-green-600",
};

// Net world safety
export const netSafetyColors: Record<string, string> = {
  helpful: "bg-green-300 text-green-900 dark:bg-green-700 dark:text-green-100",
  unclear: "bg-yellow-200 text-yellow-800 dark:bg-yellow-700 dark:text-yellow-100",
  harmful: "bg-red-800 text-white dark:bg-red-700",
};

// Scalability / SI-readiness
export const scalabilityColors: Record<string, string> = {
  yes: "bg-green-500 text-white dark:bg-green-600",
  maybe: "bg-blue-200 text-blue-800 dark:bg-blue-700 dark:text-blue-100",
  unknown: "bg-slate-300 text-slate-700 dark:bg-slate-600 dark:text-slate-200",
  unlikely: "bg-red-300 text-red-800 dark:bg-red-700 dark:text-red-200",
  no: "bg-red-500 text-white dark:bg-red-600",
  breaks: "bg-red-800 text-white dark:bg-red-700",
};

// Robustness levels
export const robustnessColors: Record<string, string> = {
  strong: "bg-green-300 text-green-900 dark:bg-green-700 dark:text-green-100",
  "strong (if solved)": "bg-green-300 text-green-900 dark:bg-green-700 dark:text-green-100",
  partial: "bg-yellow-200 text-yellow-800 dark:bg-yellow-700 dark:text-yellow-100",
  weak: "bg-orange-300 text-orange-900 dark:bg-orange-700 dark:text-orange-100",
  none: "bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200",
};

// Differential progress
export const differentialColors: Record<string, string> = {
  "safety-dominant": "bg-green-800 text-white dark:bg-green-700",
  "safety-leaning": "bg-green-500 text-white dark:bg-green-600",
  balanced: "bg-yellow-200 text-yellow-800 dark:bg-yellow-700 dark:text-yellow-100",
  "capability-leaning": "bg-orange-400 text-orange-900 dark:bg-orange-600 dark:text-orange-100",
  "capability-dominant": "bg-red-500 text-white dark:bg-red-600",
};

// Recommendation levels
export const recommendationColors: Record<string, string> = {
  prioritize: "bg-green-800 text-white font-bold dark:bg-green-700",
  increase: "bg-green-300 text-green-900 dark:bg-green-700 dark:text-green-100",
  maintain: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  reduce: "bg-red-300 text-red-800 dark:bg-red-700 dark:text-red-200",
  defund: "bg-red-800 text-white dark:bg-red-700",
};

// Lab incentive
export const incentiveColors: Record<string, string> = {
  core: "bg-blue-600 text-white dark:bg-blue-700",
  moderate: "bg-blue-400 text-blue-900 dark:bg-blue-600 dark:text-blue-100",
  negative: "bg-green-500 text-white dark:bg-green-600",
};

// Architecture relevance
export const archRelevanceColors: Record<string, string> = {
  critical: "bg-green-800 text-white dark:bg-green-700",
  high: "bg-green-500 text-white dark:bg-green-600",
  medium: "bg-yellow-200 text-yellow-800 dark:bg-yellow-700 dark:text-yellow-100",
  low: "bg-orange-300 text-orange-900 dark:bg-orange-700 dark:text-orange-100",
  not_applicable: "bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400",
};

// Generalization level colors (safety-generalizability)
export const generalizationColors: Record<string, string> = {
  low: "bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200",
  medium: "bg-amber-200 text-amber-800 dark:bg-amber-800 dark:text-amber-200",
  "medium-high": "bg-blue-200 text-blue-800 dark:bg-blue-800 dark:text-blue-200",
  high: "bg-teal-200 text-teal-800 dark:bg-teal-800 dark:text-teal-200",
  highest: "bg-green-200 text-green-800 dark:bg-green-800 dark:text-green-200",
};

// Safety-specific color maps for fallback waterfall
const safetyColorMaps = [
  recommendationColors,
  differentialColors,
  netSafetyColors,
  safetyUpliftColors,
  capabilityUpliftColors,
  scalabilityColors,
  robustnessColors,
  incentiveColors,
];

const FALLBACK_CLASS = "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200";

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
      case "safetyUplift":
        if (safetyUpliftColors[l]) return safetyUpliftColors[l];
        break;
      case "capabilityUplift":
        if (capabilityUpliftColors[l]) return capabilityUpliftColors[l];
        break;
      case "netSafety":
        if (netSafetyColors[l]) return netSafetyColors[l];
        break;
      case "scalability":
        if (scalabilityColors[l]) return scalabilityColors[l];
        break;
      case "robustness":
        if (robustnessColors[l]) return robustnessColors[l];
        break;
      case "differential":
        if (differentialColors[l]) return differentialColors[l];
        break;
      case "recommendation":
        if (recommendationColors[l]) return recommendationColors[l];
        break;
      case "incentive":
        if (incentiveColors[l]) return incentiveColors[l];
        break;
      case "archRelevance":
        if (archRelevanceColors[l]) return archRelevanceColors[l];
        break;
      case "generalization":
        if (generalizationColors[l]) return generalizationColors[l];
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
  return FALLBACK_CLASS;
}

/**
 * Get badge color class by searching all safety color maps (waterfall).
 * Preserves the behavior of the old safety-table-styles.ts getBadgeColorClass.
 */
export function getBadgeColorClass(level: string): string {
  const l = level.toLowerCase();

  for (const colorMap of safetyColorMaps) {
    if (colorMap[l]) return colorMap[l];
  }

  // Check misc values
  if (l === "n/a") return levelColors["n/a"];
  if (l === "???") return levelColors["???"];

  return FALLBACK_CLASS;
}

/**
 * Get safety outlook badge class
 */
export function getSafetyOutlookClass(rating: string): string {
  const l = rating.toLowerCase();
  return safetyOutlookColors[l] || safetyOutlookColors.unknown;
}

/**
 * Get architecture relevance badge class
 */
export function getArchRelevanceClass(level: string): string {
  const l = level.toLowerCase().replace('_', '_');
  return archRelevanceColors[l] || "bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400";
}

// Sorting order maps (merged from both files)
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
  "demonstrated-lab": 3,
  demonstrated_lab: 3,
  "observed-current": 4,
  observed_current: 4,
  // Timeline
  "long-term": 1,
  long_term: 1,
  "medium-term": 2,
  medium_term: 2,
  "near-term": 3,
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
  "very-difficult": 1,
  very_difficult: 1,
  // Safety outlook
  favorable: 4,
  mixed: 3,
  challenging: 2,
  // Safety-specific levels
  critical: 5,
  negligible: 1,
  dominant: 5,
  significant: 4,
  some: 3,
  neutral: 2,
  tax: 1,
  negative: 1,
  helpful: 3,
  unclear: 2,
  harmful: 1,
  yes: 5,
  maybe: 3,
  unlikely: 1,
  no: 0,
  breaks: 0,
  strong: 4,
  "strong (if solved)": 4,
  weak: 2,
  universal: 4,
  widespread: 3,
  experimental: 2,
  "safety-dominant": 5,
  "safety-leaning": 4,
  balanced: 3,
  "capability-leaning": 2,
  "capability-dominant": 1,
  prioritize: 5,
  increase: 4,
  maintain: 3,
  reduce: 2,
  defund: 1,
  // Generalization
  highest: 5,
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

// Category sort order (architecture scenarios)
export const categorySortOrder: Record<string, number> = {
  deployment: 1,
  "base-arch": 2,
  "alt-compute": 3,
  "non-ai": 4,
};

export function getCategorySortValue(category: string): number {
  return categorySortOrder[category] ?? 99;
}
