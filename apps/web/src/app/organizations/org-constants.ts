/** Fallback Tailwind class string when an org type has no specific color mapping. */
export const DEFAULT_ORG_TYPE_COLOR =
  "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";

/** Human-readable labels for org types used in badges and filters. */
export const ORG_TYPE_LABELS: Record<string, string> = {
  "frontier-lab": "Frontier AI Lab",
  "safety-org": "Safety Organization",
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

/** Human-readable labels for funding program types. */
export const PROGRAM_TYPE_LABELS: Record<string, string> = {
  rfp: "RFP",
  "grant-round": "Grant Round",
  fellowship: "Fellowship",
  prize: "Prize",
  solicitation: "Solicitation",
  call: "Call",
};

/** Tailwind class strings for funding program type badge colors. */
export const PROGRAM_TYPE_COLORS: Record<string, string> = {
  rfp: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  "grant-round": "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  fellowship: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  prize: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  solicitation: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
  call: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
};
