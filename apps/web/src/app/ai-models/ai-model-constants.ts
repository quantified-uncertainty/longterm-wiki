/**
 * Shared constants and formatting utilities for /ai-models routes.
 */

export const DEVELOPER_COLORS: Record<string, string> = {
  anthropic:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  openai:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  deepmind:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "meta-ai":
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  "mistral-ai":
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  xai: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
  deepseek:
    "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
};

export const SAFETY_LEVEL_COLORS: Record<string, string> = {
  "ASL-1":
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  "ASL-2":
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  "ASL-3":
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  "ASL-4":
    "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

/**
 * Format a context window token count for display.
 * Values < 10,000 are shown as plain numbers with commas (e.g., "4,096").
 * Values >= 10,000 are shown with K/M suffix (e.g., "128K", "1M").
 */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  if (tokens >= 10_000) return `${tokens / 1_000}K`;
  return tokens.toLocaleString("en-US");
}
