/**
 * Shared color and label constants for division types and statuses.
 * Importable by both server and client components.
 */

export const DIVISION_TYPE_LABELS: Record<string, string> = {
  fund: "Fund",
  team: "Team",
  department: "Department",
  lab: "Lab",
  "program-area": "Program Area",
};

export const DIVISION_TYPE_COLORS: Record<string, string> = {
  fund: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  team: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  department:
    "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  lab: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  "program-area":
    "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
};

export const STATUS_COLORS: Record<string, string> = {
  active:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  inactive:
    "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  dissolved:
    "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};
