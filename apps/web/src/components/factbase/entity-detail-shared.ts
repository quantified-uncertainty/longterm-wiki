import type { FactBaseRecordEntry } from "@/data/factbase";

// ─── Types ──────────────────────────────────────────────────────────

export type VerdictType = "confirmed" | "contradicted" | "unverifiable" | "outdated" | "partial" | "unchecked";

export interface VerdictRow {
  recordType: string;
  recordId: string;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sourcesChecked: number | null;
  needsRecheck: boolean | null;
  lastComputedAt: string | null;
}

export interface VerdictsResponse {
  verdicts: VerdictRow[];
  total: number;
}

// ─── Constants ──────────────────────────────────────────────────────

export const VERDICT_STYLES: Record<VerdictType, { label: string; className: string }> = {
  confirmed:    { label: "Confirmed",    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  contradicted: { label: "Contradicted", className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300" },
  outdated:     { label: "Outdated",     className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
  partial:      { label: "Partial",      className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
  unverifiable: { label: "Unverifiable", className: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
  unchecked:    { label: "Unchecked",    className: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
};

/** Properties to show as hero stat cards (order matters). */
export const HERO_STAT_PROPERTIES: Record<string, string[]> = {
  organization: ["revenue", "valuation", "headcount", "total-funding", "enterprise-market-share", "founded-date"],
  person: ["employed-by", "role", "net-worth", "born-year"],
  "ai-model": ["developed-by", "parameter-count", "context-window", "model-release-date"],
};

/** Collections that get special rendering. */
export const SPECIAL_COLLECTIONS = new Set([
  "key-persons",
  "funding-rounds",
  "model-releases",
  "products",
]);

// ─── Helpers ────────────────────────────────────────────────────────

/** Safely get a string field from a record, or undefined. */
export function field(item: FactBaseRecordEntry, key: string): string | undefined {
  const v = item.fields[key];
  if (v == null) return undefined;
  return String(v);
}

/** Sort record entries by a date field, newest first. */
export function sortByDateField(items: FactBaseRecordEntry[], fieldName: string): FactBaseRecordEntry[] {
  return [...items].sort((a, b) => {
    const dateA = a.fields[fieldName] ? String(a.fields[fieldName]) : "";
    const dateB = b.fields[fieldName] ? String(b.fields[fieldName]) : "";
    return dateB.localeCompare(dateA);
  });
}
