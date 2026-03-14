import { formatCompactCurrency } from "@/lib/format-compact";

export const CLUSTER_COLORS: Record<string, string> = {
  "alignment-training": "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  interpretability: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  evaluation: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  "ai-control": "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  "scalable-oversight": "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300",
  governance: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  "capabilities-research": "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
  "information-integrity": "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  biosecurity: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
};

export const STATUS_COLORS: Record<string, string> = {
  active: "text-green-600 dark:text-green-400",
  emerging: "text-blue-600 dark:text-blue-400",
  mature: "text-slate-600 dark:text-slate-400",
  declining: "text-orange-600 dark:text-orange-400",
  archived: "text-gray-400 dark:text-gray-500",
};

/** Words that should remain uppercase when formatting cluster names. */
const UPPERCASE_WORDS = new Set(["ai", "ml"]);

export function formatCluster(cluster: string): string {
  return cluster
    .split("-")
    .map((w) => UPPERCASE_WORDS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Format a funding amount string for display. Returns "-" for zero/missing. */
export function formatFunding(amount: string): string {
  const n = parseFloat(amount);
  if (!n || n === 0) return "-";
  return formatCompactCurrency(n);
}
