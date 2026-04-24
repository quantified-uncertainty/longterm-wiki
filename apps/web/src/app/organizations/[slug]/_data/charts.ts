import type { Fact } from "@longterm-wiki/factbase";
import type { KBRecordEntry } from "@/data/factbase";
import {
  getKBFacts,
  getKBProperty,
  getKBFactsByProperty,
} from "@/data/factbase";
import { titleCase } from "@/components/wiki/factbase/format";
import { resolveEntityName } from "@/lib/resolve-entity-name";
import { numericValue } from "./common";
import type { ParsedEquityPositionRecord } from "./equity-positions";

/** Extract numeric value from a Fact, handling ranges. */
function factNumericValue(fact: Fact): number | null {
  if (fact.value.type === "number") return fact.value.value;
  if (fact.value.type === "range") return (fact.value.low + fact.value.high) / 2;
  return null;
}

function factRange(fact: Fact): { low?: number; high?: number } {
  if (fact.value.type === "range") return { low: fact.value.low, high: fact.value.high };
  return {};
}

export interface FundingTimelineEntry {
  date: string;
  raised: number;
  cumulativeRaised: number;
  roundName: string;
  valuation: number | null;
}

/** A group of market share entries for a single property (e.g., "Enterprise Market Share"). */
export interface MarketShareGroup {
  /** Display name of the market (from property name, e.g., "Enterprise Market Share") */
  title: string;
  /** The property ID (e.g., "enterprise-market-share") */
  propertyId: string;
  /** Latest date for the current entity's data */
  asOf?: string;
  /** Entries for all entities with data for this property */
  entries: Array<{ company: string; share: number; color: string; isCurrent: boolean }>;
}

export interface ChartDataBundle {
  /** Valuation over time (from KB facts) */
  valuationSeries: Array<{ date: string; value: number; label?: string }>;
  /** Revenue over time (from KB facts) */
  revenueSeries: Array<{ date: string; value: number; low?: number; high?: number }>;
  /** Headcount over time (from KB facts) */
  headcountSeries: Array<{ date: string; value: number; low?: number; high?: number }>;
  /** Equity holders for breakdown chart */
  equityHolders: Array<{
    name: string;
    stakePercent: number;
    stakeLow?: number;
    stakeHigh?: number;
    color: string;
    href: string | null;
  }>;
  /** Latest valuation for equity value computation */
  latestValuation: number | null;
  /** Funding round annotations for valuation chart */
  fundingAnnotations: Array<{ date: string; label: string; raised?: number; valuation?: number }>;
  /** Funding rounds with cumulative totals for timeline chart */
  fundingTimelineSeries: FundingTimelineEntry[];
  /** Market share competitive landscape charts — one per market-share property the entity has data for */
  marketShareGroups: MarketShareGroup[];
}

export function buildChartData(
  entityId: string,
  sortedRounds: KBRecordEntry[],
  equityPositions: ParsedEquityPositionRecord[],
): ChartDataBundle {
  // Extract fact time series — exclude expired facts (validEnd in the past)
  const now = new Date().toISOString().slice(0, 10);
  const isActive = (f: Fact) => !f.validEnd || f.validEnd >= now;

  const valuationFacts = getKBFacts(entityId, "valuation").filter(isActive);
  const revenueFacts = getKBFacts(entityId, "revenue").filter(isActive);
  const headcountFacts = getKBFacts(entityId, "headcount").filter(isActive);

  const valuationSeries = valuationFacts
    .filter((f) => f.asOf && factNumericValue(f) != null)
    .map((f) => {
      // Try to match to a funding round for label
      const round = sortedRounds.find((r) => {
        const roundDate = r.fields.date ? String(r.fields.date) : "";
        const prefix = f.asOf!.slice(0, 7);
        // Only match if we have month-level precision (7+ chars like "2024-03")
        if (prefix.length < 7) return false;
        return roundDate && roundDate.startsWith(prefix);
      });
      const roundName = round ? (round.fields.name ? String(round.fields.name) : titleCase(round.key)) : undefined;
      return { date: f.asOf!, value: factNumericValue(f)!, label: roundName };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const revenueSeries = revenueFacts
    .filter((f) => f.asOf && factNumericValue(f) != null)
    .map((f) => ({
      date: f.asOf!,
      value: factNumericValue(f)!,
      ...factRange(f),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const headcountSeries = headcountFacts
    .filter((f) => f.asOf && factNumericValue(f) != null)
    .map((f) => ({
      date: f.asOf!,
      value: factNumericValue(f)!,
      ...factRange(f),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Equity holders with colors
  const EQUITY_COLORS = [
    "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6",
    "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#64748b",
    "#a855f7", "#06b6d4",
  ];

  const equityHolders = equityPositions
    .filter((p) => p.holderName && numericValue(p.stake) > 0)
    .map((p, i) => {
      const midpoint = numericValue(p.stake);
      const isRange = Array.isArray(p.stake);
      return {
        name: p.holderName,
        stakePercent: midpoint * 100,
        stakeLow: isRange ? (p.stake as [number, number])[0] * 100 : undefined,
        stakeHigh: isRange ? (p.stake as [number, number])[1] * 100 : undefined,
        href: p.holderHref,
      };
    });

  // Assign colors after sorting
  equityHolders.sort((a, b) => b.stakePercent - a.stakePercent);
  const coloredEquity = equityHolders.map((h, i) => ({
    ...h,
    color: EQUITY_COLORS[i % EQUITY_COLORS.length],
  }));

  const latestValuation = valuationSeries.length > 0
    ? valuationSeries[valuationSeries.length - 1].value
    : null;

  // Funding round annotations
  const fundingAnnotations = sortedRounds
    .filter((r) => r.fields.date)
    .map((r) => ({
      date: String(r.fields.date),
      label: r.fields.name ? String(r.fields.name) : titleCase(r.key),
      raised: typeof r.fields.raised === "number" ? r.fields.raised : undefined,
      valuation: typeof r.fields.valuation === "number" ? r.fields.valuation : undefined,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Funding timeline: rounds with raised amounts, sorted by date, with cumulative total
  const fundingTimelineSeries: FundingTimelineEntry[] = [];
  let cumulative = 0;
  for (const r of sortedRounds) {
    const raised = typeof r.fields.raised === "number" ? r.fields.raised : null;
    const date = r.fields.date ? String(r.fields.date) : null;
    if (raised == null || raised <= 0 || !date) continue;
    cumulative += raised;
    fundingTimelineSeries.push({
      date,
      raised,
      cumulativeRaised: cumulative,
      roundName: r.fields.name ? String(r.fields.name) : titleCase(r.key),
      valuation: typeof r.fields.valuation === "number" ? r.fields.valuation : null,
    });
  }
  // sortedRounds is already date-sorted, but ensure chronological order
  fundingTimelineSeries.sort((a, b) => a.date.localeCompare(b.date));
  // Recompute cumulative after sort in case sortedRounds order differed
  let cumulativeCheck = 0;
  for (const entry of fundingTimelineSeries) {
    cumulativeCheck += entry.raised;
    entry.cumulativeRaised = cumulativeCheck;
  }

  // ── Market share competitive landscape ──
  // Find all market-share properties the current entity has facts for,
  // then build competitive landscape charts showing all entities with that property.
  const MARKET_SHARE_COLORS = [
    "#3b82f6", "#ef4444", "#22c55e", "#f59e0b", "#8b5cf6",
    "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#64748b",
  ];

  const allEntityFacts = getKBFacts(entityId);
  const marketSharePropertyIds = [
    ...new Set(
      allEntityFacts
        .filter((f) => f.propertyId.endsWith("-market-share") && f.propertyId !== "market-share")
        .map((f) => f.propertyId)
    ),
  ];

  const marketShareGroups: MarketShareGroup[] = marketSharePropertyIds.map((propId) => {
    const prop = getKBProperty(propId);
    const latestByEntity = getKBFactsByProperty(propId);

    // Get the current entity's latest fact for this property to extract asOf
    const currentEntityFact = latestByEntity.get(entityId);

    const entries = [...latestByEntity.entries()]
      .map(([eid, fact]) => {
        const val = factNumericValue(fact);
        if (val == null || val <= 0) return null;
        const resolved = resolveEntityName(eid);
        return {
          company: resolved.name,
          share: val,
          color: "", // assigned below after sorting
          isCurrent: eid === entityId,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e != null)
      .sort((a, b) => b.share - a.share)
      .map((e, i) => ({
        ...e,
        color: e.isCurrent
          ? "#3b82f6" // highlight current entity in blue
          : MARKET_SHARE_COLORS[(i + 1) % MARKET_SHARE_COLORS.length],
      }));

    return {
      title: prop?.name ?? titleCase(propId.replace(/-/g, " ")),
      propertyId: propId,
      asOf: currentEntityFact?.asOf ?? undefined,
      entries,
    };
  }).filter((g) => g.entries.length > 0);

  return {
    valuationSeries,
    revenueSeries,
    headcountSeries,
    equityHolders: coloredEquity,
    latestValuation,
    fundingAnnotations,
    fundingTimelineSeries,
    marketShareGroups,
  };
}
