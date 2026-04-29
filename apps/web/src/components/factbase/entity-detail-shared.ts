import type { FactBaseRecordEntry } from "@/data/factbase";
import { titleCase } from "@/components/wiki/factbase/format";

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

// ─── Display-name resolution (QUA-771) ──────────────────────────────
//
// These helpers replace ad-hoc fallback chains scattered across the wiki
// frontend. Keep the derivation in one place so both write-side validation
// and read-side rendering can refer to a single canonical function.
//
// Why `||` instead of `??`: empty strings should fall through to the
// titleCase fallback (a record with `name: ""` should NOT render a blank
// label). This matches the truthy-check semantics the original ad-hoc
// chains used in `app/organizations/[slug]/_data/charts.ts`. `??` would
// have returned the empty string and rendered nothing.

/**
 * Strict-typed read of a record field for display purposes. Returns
 * `undefined` for:
 *   - missing / null
 *   - arrays / objects (so `name: [foo, bar]` doesn't render as `"foo,bar"`)
 *   - JS-falsy primitives (`""`, `0`, `false`)
 *
 * This matches the original `r.fields.name ? String(r.fields.name) : ...`
 * truthy-check semantics that ad-hoc fallback chains used in charts.ts
 * and the defensive local `field()` in `FBAutoFacts.tsx`. Combine with
 * `||` to fall through to a derived label.
 */
function recordFieldString(item: FactBaseRecordEntry, key: string): string | undefined {
  const v = item.fields[key];
  if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return undefined;
  return v ? String(v) : undefined;
}

/**
 * Canonical display name for a FactBase record entry.
 *
 * Replaces the `field(item, "name") ?? titleCase(item.key)` and
 * `r.fields.name ? String(r.fields.name) : titleCase(r.key)` patterns
 * duplicated across record renderers (funding rounds, products, model
 * releases, etc.). Per QUA-771 / data-integrity tier 6.
 *
 * Empty-string and zero/false names fall through to the title-cased key
 * — a blank or `"0"` label would be a worse display than the derived one.
 */
export function getRecordDisplayName(item: FactBaseRecordEntry): string {
  return recordFieldString(item, "name") || titleCase(item.key);
}

/**
 * Canonical display name for a person record entry. Prefers the linked
 * KB entity's name, then the explicit `displayName`, then a `display_name`
 * field, then the title-cased key.
 *
 * Replaces the `personEntity?.name ?? item.displayName ?? ... ?? titleCase(item.key)`
 * chain duplicated across person-card components.
 */
export function getPersonRecordName(
  item: FactBaseRecordEntry,
  personEntity?: { name: string } | null,
): string {
  return (
    personEntity?.name ||
    item.displayName ||
    recordFieldString(item, "display_name") ||
    titleCase(item.key)
  );
}

/**
 * Canonical label for a FactBase property. Uses the property's `name` if
 * defined and non-empty; otherwise derives a title-cased label from the
 * property ID.
 *
 * Replaces the `prop?.name ?? titleCase(propertyId)` pattern duplicated
 * across fact tables, charts, sidebars, and stat cards.
 */
export function getPropertyLabel(
  prop: { name?: string | null } | null | undefined,
  propertyId: string,
): string {
  return prop?.name || titleCase(propertyId);
}
