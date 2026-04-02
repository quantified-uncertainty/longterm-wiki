/**
 * Shared constants for /politicians routes.
 */

/** AI stance badge colors. */
export const AI_STANCE_COLORS: Record<string, string> = {
  "strongly supportive":
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  supportive:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  "mildly supportive":
    "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400",
  neutral:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  mixed:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  opposed:
    "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  "strongly opposed":
    "bg-red-200 text-red-900 dark:bg-red-900/40 dark:text-red-300",
  unknown:
    "bg-gray-50 text-gray-400 dark:bg-gray-900 dark:text-gray-500",
};

/** Party colors. */
export const PARTY_COLORS: Record<string, string> = {
  democratic:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  republican:
    "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  independent:
    "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
};

/** Status colors. */
export const STATUS_COLORS: Record<string, string> = {
  incumbent:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  candidate:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  former:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

/** EA-relevant position topics to display as columns. */
export const EA_TOPICS = [
  "AI safety and regulation",
  "Biosafety",
  "Animal welfare",
  "Science and technology funding",
  "Nuclear energy",
] as const;

/**
 * Extract a short stance label from a position view string.
 * e.g., "Strongly supportive — authored RAISE Act..." → "strongly supportive"
 */
export function extractStanceLabel(view: string | undefined): string {
  if (!view) return "unknown";
  const lower = view.toLowerCase();
  if (lower.startsWith("strongly supportive") || lower.startsWith("strongly pro")) return "strongly supportive";
  if (lower.startsWith("supportive") || lower.startsWith("pro")) return "supportive";
  if (lower.startsWith("mildly supportive")) return "mildly supportive";
  if (lower.startsWith("opposed") || lower.startsWith("anti")) return "opposed";
  if (lower.startsWith("strongly opposed")) return "strongly opposed";
  if (lower.startsWith("likely opposed")) return "opposed";
  if (lower.startsWith("mixed")) return "mixed";
  if (lower.startsWith("neutral")) return "neutral";
  return "unknown";
}
