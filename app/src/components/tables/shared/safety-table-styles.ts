/**
 * Safety Approaches Table Style Configuration
 *
 * Extends the shared style-config with safety-specific badge colors.
 * Uses Tailwind classes with dark mode support.
 */

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

// Adoption levels
export const adoptionColors: Record<string, string> = {
  experimental: "bg-purple-200 text-purple-800 dark:bg-purple-800 dark:text-purple-200",
  widespread: "bg-blue-400 text-blue-900 dark:bg-blue-600 dark:text-blue-100",
  universal: "bg-blue-600 text-white dark:bg-blue-700",
};

// Architecture relevance
export const archRelevanceColors: Record<string, string> = {
  critical: "bg-green-800 text-white dark:bg-green-700",
  high: "bg-green-500 text-white dark:bg-green-600",
  medium: "bg-yellow-200 text-yellow-800 dark:bg-yellow-700 dark:text-yellow-100",
  low: "bg-orange-300 text-orange-900 dark:bg-orange-700 dark:text-orange-100",
  not_applicable: "bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400",
};

// Lab incentive
export const incentiveColors: Record<string, string> = {
  core: "bg-blue-600 text-white dark:bg-blue-700",
  moderate: "bg-blue-400 text-blue-900 dark:bg-blue-600 dark:text-blue-100",
  negative: "bg-green-500 text-white dark:bg-green-600",
};

// N/A and unknown
export const miscColors: Record<string, string> = {
  "n/a": "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  "???": "bg-slate-300 text-slate-600 dark:bg-slate-600 dark:text-slate-300",
};

// Category colors
export const categoryColors: Record<string, { dot: string; border: string }> = {
  training: { dot: "bg-blue-500", border: "border-blue-300 dark:border-blue-700" },
  interpretability: { dot: "bg-purple-500", border: "border-purple-300 dark:border-purple-700" },
  evaluation: { dot: "bg-amber-500", border: "border-amber-300 dark:border-amber-700" },
  architectural: { dot: "bg-green-500", border: "border-green-300 dark:border-green-700" },
  governance: { dot: "bg-slate-500", border: "border-slate-300 dark:border-slate-700" },
  theoretical: { dot: "bg-pink-500", border: "border-pink-300 dark:border-pink-700" },
};

/**
 * Get badge color class for a level string
 */
export function getBadgeColorClass(level: string): string {
  const l = level.toLowerCase();

  // Check each color map in priority order
  if (recommendationColors[l]) return recommendationColors[l];
  if (differentialColors[l]) return differentialColors[l];
  if (netSafetyColors[l]) return netSafetyColors[l];
  if (safetyUpliftColors[l]) return safetyUpliftColors[l];
  if (capabilityUpliftColors[l]) return capabilityUpliftColors[l];
  if (scalabilityColors[l]) return scalabilityColors[l];
  if (robustnessColors[l]) return robustnessColors[l];
  if (adoptionColors[l]) return adoptionColors[l];
  if (incentiveColors[l]) return incentiveColors[l];
  if (miscColors[l]) return miscColors[l];

  // Fallback
  return "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200";
}

/**
 * Get architecture relevance badge class
 */
export function getArchRelevanceClass(level: string): string {
  const l = level.toLowerCase().replace('_', '_');
  return archRelevanceColors[l] || "bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400";
}

// Sorting order maps (higher value = sorted later in ascending order)
export const levelSortOrder: Record<string, number> = {
  // Safety uplift (higher = better)
  critical: 5, high: 4, medium: 3, "low-medium": 2.5, low: 2, negligible: 1,
  // Capability uplift (higher = worse for safety)
  dominant: 5, significant: 4, some: 3, neutral: 2, tax: 1, negative: 1,
  // Net safety
  helpful: 3, unclear: 2, harmful: 1,
  // Scalability / SI-ready
  yes: 5, maybe: 3, unknown: 2, unlikely: 1, no: 0, breaks: 0,
  // Robustness
  strong: 4, "strong (if solved)": 4, partial: 3, weak: 2, none: 1,
  // Adoption
  universal: 4, widespread: 3, experimental: 2,
  // Differential progress
  "safety-dominant": 5, "safety-leaning": 4, balanced: 3, "capability-leaning": 2, "capability-dominant": 1,
  // Recommendation
  prioritize: 5, increase: 4, maintain: 3, reduce: 2, defund: 1,
  // Fallback
  "n/a": 0, "???": 0,
};

export function getLevelSortValue(level: string): number {
  const l = level.toLowerCase();
  if (levelSortOrder[l] !== undefined) return levelSortOrder[l];
  // Check for partial matches
  for (const [key, value] of Object.entries(levelSortOrder)) {
    if (l.includes(key) || key.includes(l)) return value;
  }
  return 0;
}

// Category sort order
export const categorySortOrder: Record<string, number> = {
  training: 1,
  interpretability: 2,
  evaluation: 3,
  architectural: 4,
  governance: 5,
  theoretical: 6,
};
