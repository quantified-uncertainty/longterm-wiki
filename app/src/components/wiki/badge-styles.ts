/**
 * Shared badge color maps for wiki data components.
 * Single source of truth for domain, stance, priority, category, feasibility, and coverage styles.
 */

// -- Proposal domain badges --
export const domainBadge: Record<string, string> = {
  philanthropic: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  biosecurity: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
  governance: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  technical: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  "field-building": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  financial: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
};

// -- Proposal stance badges --
export const stanceBadge: Record<string, string> = {
  collaborative: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  adversarial: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  neutral: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

// -- Intervention priority badges --
export const priorityBadge: Record<string, string> = {
  "Very High": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  "High": "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  "Medium-High": "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  "Medium": "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

// -- Intervention category badges --
export const categoryBadge: Record<string, string> = {
  technical: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  governance: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  institutional: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  "field-building": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  resilience: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
};

// -- Feasibility indicators --
export const feasibilityColor: Record<string, string> = {
  high: "text-green-700 dark:text-green-400",
  medium: "text-yellow-700 dark:text-yellow-400",
  low: "text-red-700 dark:text-red-400",
};

export const feasibilityDot: Record<string, string> = {
  high: "bg-green-500",
  medium: "bg-yellow-500",
  low: "bg-red-500",
};

// -- Coverage levels (for risk coverage matrix) --
export const coverageColor: Record<string, string> = {
  high: "text-red-700 dark:text-red-400 font-semibold",
  medium: "text-orange-600 dark:text-orange-400",
  low: "text-slate-500 dark:text-slate-400",
  none: "text-slate-300 dark:text-slate-600",
};

// -- ITN labels --
export const itnLabel: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

// -- Status labels --
export const statusLabel: Record<string, string> = {
  idea: "Idea",
  proposed: "Proposed",
  "in-progress": "In Progress",
  implemented: "Implemented",
  abandoned: "Abandoned",
};
