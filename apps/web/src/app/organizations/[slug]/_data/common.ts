/**
 * Shared primitives, constants, and small helpers used across the
 * per-record-type modules in this directory.
 */
import type { Fact } from "@longterm-wiki/factbase";
import { getKBProperty } from "@/data/factbase";
import { formatKBNumber, titleCase } from "@/components/wiki/factbase/format";

// ── Numeric / range helpers ──────────────────────────────────────────

/** A numeric value that can be a single number or a [min, max] range. */
export type NumericOrRange = number | [number, number];

/** Parse a value that may be a single number or a 2-element array range. */
export function parseNumericOrRange(value: unknown): NumericOrRange | null {
  if (typeof value === "number" && isFinite(value)) return value;
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((v) => typeof v === "number" && isFinite(v))
  ) {
    return [value[0], value[1]] as [number, number];
  }
  // Handle numeric strings (e.g., "50000" from YAML)
  if (typeof value === "string") {
    const num = Number(value);
    if (isFinite(num)) return num;
  }
  return null;
}

/** Get a single numeric value from NumericOrRange (midpoint for ranges). */
export function numericValue(v: NumericOrRange | null): number {
  if (v == null) return 0;
  if (Array.isArray(v)) {
    const mid = (v[0] + v[1]) / 2;
    return isNaN(mid) ? 0 : mid;
  }
  return isNaN(v) ? 0 : v;
}

// ── Author reference ─────────────────────────────────────────────────

export interface AuthorRef {
  name: string;
  href: string | null;
}

// ── Curated collection names ──────────────────────────────────────────

export const CURATED_COLLECTIONS = new Set([
  "funding-rounds",
  "investments",
  "key-persons",
  "products",
  "model-releases",
  "safety-milestones",
  "strategic-partnerships",
  "board-seats",
  "divisions",
  "funding-programs",
  "personnel",
  "grants",
  "equity-positions",
  "charitable-pledges",
  "dilution-stages",
]);

// ── Constants ─────────────────────────────────────────────────────────

export const HERO_STATS = [
  "revenue",
  "valuation",
  "headcount",
  "total-funding",
  "annual-expenses",
  "net-assets",
];

export {
  ORG_TYPE_LABELS,
  ORG_TYPE_COLORS,
  DEFAULT_ORG_TYPE_COLOR,
  ORG_STATUS_LABELS,
  ORG_STATUS_COLORS,
} from "@/app/organizations/org-constants";

export const FACT_CATEGORIES: { id: string; label: string; order: number }[] = [
  { id: "financial", label: "Financial", order: 0 },
  { id: "product", label: "Products & Usage", order: 1 },
  { id: "organization", label: "Organization", order: 2 },
  { id: "safety", label: "Safety & Research", order: 3 },
  { id: "people", label: "People", order: 4 },
  { id: "other", label: "Other", order: 99 },
];

export const SAFETY_LEVEL_COLORS: Record<string, string> = {
  "ASL-2": "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  "ASL-3": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  "ASL-4": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

export const MILESTONE_TYPE_COLORS: Record<string, string> = {
  "research-paper":
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "policy-update":
    "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  "safety-eval":
    "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  "red-team":
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
};

export const MAX_GRANTS_SHOWN = 10;

// ── Formatting helpers ────────────────────────────────────────────────

export function formatAmount(value: unknown): string | null {
  if (value == null) return null;
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((v) => typeof v === "number" && !isNaN(v))
  ) {
    return `${formatKBNumber(value[0], "USD")}\u2013${formatKBNumber(value[1], "USD")}`;
  }
  const num = typeof value === "number" ? value : Number(value);
  if (isNaN(num) || !isFinite(num)) return null;
  return formatKBNumber(num, "USD");
}

// ── Fact sidebar helpers ──────────────────────────────────────────────

/** Group facts by property, taking only the latest per property. */
export function getLatestFactsByProperty(facts: Fact[]): Map<string, Fact> {
  const latest = new Map<string, Fact>();
  for (const fact of facts) {
    if (fact.propertyId === "description") continue;
    if (!latest.has(fact.propertyId)) {
      latest.set(fact.propertyId, fact);
    }
  }
  return latest;
}

/** Group property IDs by category, returning sorted categories. */
export function groupByCategory(
  propertyIds: string[],
): Array<{ category: string; label: string; props: string[] }> {
  const groups = new Map<string, string[]>();
  for (const propId of propertyIds) {
    const prop = getKBProperty(propId);
    const category = prop?.category ?? "other";
    const list = groups.get(category) ?? [];
    list.push(propId);
    groups.set(category, list);
  }

  const catMap = new Map(FACT_CATEGORIES.map((c) => [c.id, c]));
  return [...groups.entries()]
    .map(([catId, props]) => ({
      category: catId,
      label: catMap.get(catId)?.label ?? titleCase(catId),
      order: catMap.get(catId)?.order ?? 99,
      props,
    }))
    .sort((a, b) => a.order - b.order);
}

// ── Org age helper ───────────────────────────────────────────────────

export function computeOrgAge(foundedDateStr: string | undefined): string | null {
  if (!foundedDateStr) return null;
  const founded = new Date(foundedDateStr);
  if (isNaN(founded.getTime())) return null;
  const now = new Date();
  const years = now.getFullYear() - founded.getFullYear();
  const months = now.getMonth() - founded.getMonth();
  const totalMonths = years * 12 + months;
  if (totalMonths <= 0) return null;
  if (totalMonths < 12) return `${totalMonths} months`;
  const fullYears = Math.floor(totalMonths / 12);
  return `${fullYears} year${fullYears !== 1 ? "s" : ""} old`;
}

// ── Format a stake fraction for display (e.g., 0.15 -> "15%") ────────

export function formatStake(stake: NumericOrRange): string {
  if (Array.isArray(stake)) {
    const low = (stake[0] * 100).toFixed(1).replace(/\.0$/, "");
    const high = (stake[1] * 100).toFixed(1).replace(/\.0$/, "");
    return `${low}%\u2013${high}%`;
  }
  return `${(stake * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

// ── Equity category derivation ───────────────────────────────────────

/**
 * Derive a display category for an equity holder from their investment records.
 * - If any investment has role=founder → "Co-founder"
 * - If earliest round participation is ≤ 2021-12 → "Early investor"
 * - If investor name matches major tech companies → "Strategic investor"
 * - If holder name contains "employee"/"pool" → "Employees"
 * - If holder name contains "institutional"/"other" → "Institutional"
 * - Otherwise → "Investor"
 */
export function deriveEquityCategory(
  holderName: string,
  investments: Array<{ role: string | null; date: string | null; roundName: string | null }>,
): string {
  if (investments.length === 0) {
    const lower = holderName.toLowerCase();
    if (lower.includes("employee") || lower.includes("pool")) return "Employees";
    if (lower.includes("institutional") || lower.includes("other")) return "Institutional";
    return "Investor";
  }

  if (investments.some((inv) => inv.role === "founder")) return "Co-founder";

  const dates = investments.map((inv) => inv.date).filter(Boolean) as string[];
  dates.sort();
  if (dates[0] && dates[0] <= "2021-12") return "Early investor";

  const lower = holderName.toLowerCase();
  const strategicNames = ["google", "amazon", "microsoft", "nvidia"];
  if (strategicNames.some((s) => lower.includes(s))) return "Strategic investor";

  const roundNames = investments.map((inv) => inv.roundName?.toLowerCase() ?? "");
  if (roundNames.some((n) => strategicNames.some((s) => n.includes(s)) || n.includes("partnership"))) {
    return "Strategic investor";
  }

  return "Investor";
}

/** Compute the estimated value of a stake given a valuation. Returns [low, high] for range stakes. */
export function computeStakeValue(
  stake: NumericOrRange | null,
  valuation: number,
): NumericOrRange | null {
  if (stake == null) return null;
  if (Array.isArray(stake)) return [stake[0] * valuation, stake[1] * valuation];
  return stake * valuation;
}
