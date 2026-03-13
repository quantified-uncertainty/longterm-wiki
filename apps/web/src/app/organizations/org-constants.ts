/** Human-readable labels for org types used in badges and filters. */
export const ORG_TYPE_LABELS: Record<string, string> = {
  "frontier-lab": "Frontier Lab",
  "safety-org": "Safety Org",
  academic: "Academic",
  startup: "Startup",
  generic: "Organization",
  funder: "Funder",
  government: "Government",
  other: "Other",
};

/** Tailwind class strings for org-type badge colors. */
export const ORG_TYPE_COLORS: Record<string, string> = {
  "frontier-lab": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  "safety-org": "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  academic: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  startup: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  generic: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300",
  funder: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  government: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
  other: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300",
};
