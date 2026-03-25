/** Status badge colors for political races */
export const RACE_STATUS_COLORS: Record<string, string> = {
  upcoming: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  active: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  resolved: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  cancelled: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300",
};

/** AI stance badge colors */
export const AI_STANCE_COLORS: Record<string, string> = {
  pro_regulation: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  anti_regulation: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  mixed: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  neutral: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300",
};

/** Human-readable labels for AI stances */
export const AI_STANCE_LABELS: Record<string, string> = {
  pro_regulation: "Pro-regulation",
  anti_regulation: "Anti-regulation",
  mixed: "Mixed",
  neutral: "Neutral",
};

/** Human-readable labels for race levels */
export const RACE_LEVEL_LABELS: Record<string, string> = {
  federal_house: "U.S. House",
  federal_senate: "U.S. Senate",
  state_governor: "Governor",
  state_legislature: "State Legislature",
  ballot_measure: "Ballot Measure",
};

/** Candidate status badge colors */
export const CANDIDATE_STATUS_COLORS: Record<string, string> = {
  running: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  won: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  lost: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  withdrew: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300",
};
