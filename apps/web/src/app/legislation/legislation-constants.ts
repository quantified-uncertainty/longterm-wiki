/**
 * Shared constants and formatting utilities for /legislation routes.
 */

/** Status colors for legislation outcomes. */
export const STATUS_COLORS: Record<string, string> = {
  enacted:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  vetoed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  revoked: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  expired: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  active:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  emerging:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  pending:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  proposed:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  "in-effect":
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
};

/** Scope colors for jurisdiction badges. */
export const SCOPE_COLORS: Record<string, string> = {
  federal:
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  state:
    "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
  international:
    "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  national:
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
};

/**
 * Normalize a policy status string for color lookup.
 * Handles variations like "Vetoed September 29, 2024" → "vetoed".
 */
export function normalizeStatus(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  if (lower.startsWith("vetoed")) return "vetoed";
  if (lower.startsWith("revoked")) return "revoked";
  if (lower.startsWith("enacted") || lower.startsWith("signed")) return "enacted";
  if (lower.startsWith("failed") || lower.includes("died")) return "failed";
  if (lower.startsWith("active") || lower.includes("in force") || lower.includes("in effect")) return "in-effect";
  if (lower.startsWith("pending") || lower.includes("committee")) return "pending";
  if (lower.startsWith("proposed") || lower.startsWith("introduced")) return "proposed";
  if (lower.startsWith("expired")) return "expired";
  if (lower.includes("emerging") || lower.includes("developing")) return "emerging";
  return null;
}
