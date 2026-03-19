/**
 * Shared constants for resource display: type labels, colors, stance colors.
 * Used by both ResourceCard (card view) and OrgResourcesTable (table view).
 */

// ── Type taxonomy (4C) ──────────────────────────────────────────────
// Maps raw resource types to human-readable labels.
// Extends the original set (paper, blog, web, government, etc.) with
// more specific types that can be assigned via domain heuristics or LLM.

export const RESOURCE_TYPE_LABELS: Record<string, string> = {
  paper: "Paper",
  blog: "Blog",
  report: "Report",
  book: "Book",
  web: "Web",
  government: "Government",
  talk: "Talk",
  podcast: "Podcast",
  reference: "Reference",
  // Extended taxonomy (4C)
  news_article: "News",
  legal_analysis: "Legal Analysis",
  government_doc: "Gov. Document",
  academic_paper: "Academic",
  blog_post: "Blog Post",
  press_release: "Press Release",
  think_tank: "Think Tank",
  opinion: "Opinion",
  transcript: "Transcript",
};

export const RESOURCE_TYPE_COLORS: Record<string, string> = {
  paper: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  academic_paper: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  blog: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  blog_post: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  report: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  think_tank: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  book: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  web: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  news_article: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  government: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  government_doc: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  legal_analysis: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  talk: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  transcript: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  podcast: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
  press_release: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
  opinion: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  reference: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  _default: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

// ── Stance colors ───────────────────────────────────────────────────

export const STANCE_COLORS: Record<string, string> = {
  support: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  oppose: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  neutral: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  mixed: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  analysis: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  _default: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};

// ── Credibility colors ──────────────────────────────────────────────

export function CREDIBILITY_COLORS(c: number): string {
  if (c >= 4) return "text-emerald-600";
  if (c >= 3) return "text-blue-500";
  if (c >= 2) return "text-amber-600";
  return "text-red-500";
}
