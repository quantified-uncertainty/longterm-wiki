/**
 * KBAutoFacts -- Auto-rendered KB structured data section for entity pages.
 *
 * Server component that checks if an entity has substantive KB facts
 * (beyond just a description stub) and renders them in a visually rich
 * section with hero stat cards and categorized fact tables. Designed to be
 * automatically included on entity wiki pages without requiring manual MDX
 * markup.
 */

import {
  getKBFacts,
  getKBEntity,
  getKBProperties,
  getKBLatest,
  isFactExpired,
} from "@data/kb";
import type { Fact, Property } from "@longterm-wiki/kb";
import { formatKBDate, isUrl, shortDomain, titleCase } from "@components/wiki/kb/format";
import { KBFactValueDisplay } from "@components/wiki/kb/KBFactValueDisplay";
import Link from "next/link";
import {
  ChevronRight,
  ExternalLink,
  Database,
} from "lucide-react";

interface KBAutoFactsProps {
  /** Page slug / KB entity ID (e.g., "anthropic") */
  entityId: string;
}

/** A fact grouped with its property metadata. */
interface FactWithProperty {
  fact: Fact;
  property: Property | undefined;
}

// ── Constants ────────────────────────────────────────────────────────

/** Sort categories in a stable, logical order. */
const CATEGORY_ORDER: Record<string, number> = {
  organization: 0,
  financial: 1,
  product: 2,
  people: 3,
  safety: 4,
  biographical: 5,
  model: 6,
  risk: 7,
  epistemic: 8,
  approach: 9,
  concept: 10,
  debate: 11,
  event: 12,
  policy: 13,
  project: 14,
  funder: 15,
  historical: 16,
  incident: 17,
  relationship: 18,
  research: 19,
  other: 99,
};

/** Properties to show as hero stat cards by entity type (KB entity types). */
const HERO_STAT_PROPERTIES: Record<string, string[]> = {
  organization: ["revenue", "valuation", "headcount", "total-funding", "founded-date"],
  person: ["employed-by", "role", "born-year"],
  "ai-model": ["context-window"],
};


// ── Helpers ──────────────────────────────────────────────────────────

function sortCategories(categories: string[]): string[] {
  return [...categories].sort((a, b) => {
    const orderA = CATEGORY_ORDER[a] ?? 50;
    const orderB = CATEGORY_ORDER[b] ?? 50;
    return orderA - orderB;
  });
}

/** Group facts by property category. */
function groupByCategory(
  factsWithProps: FactWithProperty[],
): Record<string, FactWithProperty[]> {
  const groups: Record<string, FactWithProperty[]> = {};
  for (const item of factsWithProps) {
    const category = item.property?.category ?? "other";
    if (!groups[category]) {
      groups[category] = [];
    }
    groups[category].push(item);
  }
  return groups;
}

/** Group facts by property ID within a category. */
function groupByProperty(
  factsWithProps: FactWithProperty[],
): Record<string, FactWithProperty[]> {
  const groups: Record<string, FactWithProperty[]> = {};
  for (const item of factsWithProps) {
    const propId = item.fact.propertyId;
    if (!groups[propId]) {
      groups[propId] = [];
    }
    groups[propId].push(item);
  }
  return groups;
}

/** Sort FactWithProperty[] by asOf descending (most recent first). */
function sortFactsByAsOf(items: FactWithProperty[]): FactWithProperty[] {
  return [...items].sort((a, b) => {
    if (!a.fact.asOf && !b.fact.asOf) return 0;
    if (!a.fact.asOf) return 1;
    if (!b.fact.asOf) return -1;
    return b.fact.asOf.localeCompare(a.fact.asOf);
  });
}

// ── Sub-components ───────────────────────────────────────────────────

/** Source indicator: link icon for URLs, text for non-URL sources, dim dash for missing. */
function SourceCell({ source }: { source: string | undefined }) {
  if (source && isUrl(source)) {
    return (
      <a
        href={source}
        className="text-muted-foreground/50 hover:text-primary transition-colors"
        target="_blank"
        rel="noopener noreferrer"
        title={shortDomain(source)}
        aria-label={`Open source ${shortDomain(source)} in a new tab`}
      >
        <ExternalLink size={12} aria-hidden="true" />
      </a>
    );
  }
  if (source) {
    return (
      <span
        className="text-xs text-muted-foreground truncate max-w-[120px]"
        title={source}
      >
        {source}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground/30" title="No source URL" aria-label="No source">
      {"\u2014"}
    </span>
  );
}

/** Section divider with title and optional count badge. */
function SectionDivider({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 mb-2 mt-5 first:mt-0">
      <h3 className="text-sm font-bold tracking-tight text-foreground">{title}</h3>
      {count != null && (
        <span className="text-[10px] font-medium tabular-nums px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
          {count}
        </span>
      )}
      <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
    </div>
  );
}

/** Hero stat card for a key metric. */
function StatCard({
  fact,
  prop,
  propertyId,
}: {
  fact: Fact;
  prop: Property | undefined;
  propertyId: string;
}) {

  return (
    <div className="relative overflow-hidden rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-3.5 transition-shadow hover:shadow-md">
      <div className="absolute top-0 right-0 w-12 h-12 bg-primary/[0.03] rounded-bl-[2rem]" />
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
        {prop?.name ?? titleCase(propertyId)}
      </div>
      <div className="text-lg font-bold tabular-nums tracking-tight text-foreground">
        <KBFactValueDisplay fact={fact} property={prop} />
      </div>
      {fact.asOf && (
        <div className="text-[10px] text-muted-foreground/50 mt-0.5">
          as of {formatKBDate(fact.asOf)}
        </div>
      )}
    </div>
  );
}

/** Render a time-series property: latest value in the main row, collapsible history. */
function TimeSeriesFactRow({
  propertyId,
  items,
}: {
  propertyId: string;
  items: FactWithProperty[];
}) {
  const prop = items[0]?.property;
  const label = prop?.name ?? titleCase(propertyId);

  const sorted = sortFactsByAsOf(items);
  const latest = sorted[0];
  const history = sorted.slice(1);

  if (!latest) return null;

  return (
    <>
      {/* Main row showing latest value */}
      <tr className="border-b border-border/30 last:border-b-0">
        <td className="py-1.5 pr-3 text-sm text-muted-foreground align-baseline whitespace-nowrap">
          {label}
        </td>
        <td className="py-1.5 pr-3 text-sm align-baseline">
          <KBFactValueDisplay fact={latest.fact} property={prop} />
        </td>
        <td className="py-1.5 pr-3 text-xs text-muted-foreground/60 align-baseline whitespace-nowrap">
          {formatKBDate(latest.fact.asOf)}
        </td>
        <td className="py-1.5 align-baseline text-center">
          <SourceCell source={latest.fact.source} />
        </td>
      </tr>
      {/* Expandable history rows */}
      {history.length > 0 && (
        <tr className="border-b border-border/30 last:border-b-0">
          <td colSpan={4} className="py-0 pb-1">
            <details className="group/ts">
              <summary className="cursor-pointer select-none text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors py-0.5 flex items-center gap-1">
                <ChevronRight
                  size={10}
                  className="transition-transform group-open/ts:rotate-90"
                />
                {history.length} earlier {history.length === 1 ? "value" : "values"}
              </summary>
              <div className="pl-3 pb-1">
                {history.map((item) => (
                  <div
                    key={item.fact.id}
                    className="flex items-baseline gap-3 py-0.5 text-xs text-muted-foreground/70"
                  >
                    <span className="whitespace-nowrap min-w-[60px]">
                      {formatKBDate(item.fact.asOf)}
                    </span>
                    <span className="text-foreground/70">
                      <KBFactValueDisplay fact={item.fact} property={prop} />
                    </span>
                    <span className="ml-auto">
                      <SourceCell source={item.fact.source} />
                    </span>
                  </div>
                ))}
              </div>
            </details>
          </td>
        </tr>
      )}
    </>
  );
}

/** Render a single-value fact row. */
function SingleFactRow({
  propertyId,
  items,
}: {
  propertyId: string;
  items: FactWithProperty[];
}) {
  // Prefer currently-active facts (not expired), then sort by asOf descending
  const candidates = items.some((item) => !isFactExpired(item.fact))
    ? items.filter((item) => !isFactExpired(item.fact))
    : items;
  const sorted = sortFactsByAsOf(candidates);
  const prop = sorted[0]?.property;
  const label = prop?.name ?? titleCase(propertyId);
  const fact = sorted[0]?.fact;

  if (!fact) return null;

  return (
    <tr className="border-b border-border/30 last:border-b-0">
      <td className="py-1.5 pr-3 text-sm text-muted-foreground align-baseline whitespace-nowrap">
        {label}
      </td>
      <td className="py-1.5 pr-3 text-sm align-baseline">
        <KBFactValueDisplay fact={fact} property={prop} />
      </td>
      <td className="py-1.5 pr-3 text-xs text-muted-foreground/60 align-baseline whitespace-nowrap">
        {fact.asOf ? formatKBDate(fact.asOf) : ""}
      </td>
      <td className="py-1.5 align-baseline text-center">
        <SourceCell source={fact.source} />
      </td>
    </tr>
  );
}

// ── Main component ───────────────────────────────────────────────────

export function KBAutoFacts({ entityId }: KBAutoFactsProps) {
  const allFacts = getKBFacts(entityId);
  const kbEntity = getKBEntity(entityId);

  // Filter out description-only stubs
  const substantiveFacts = allFacts.filter(
    (f) => f.propertyId !== "description",
  );

  // Don't render if no substantive facts
  if (substantiveFacts.length === 0) {
    return null;
  }

  const allProperties = getKBProperties();
  const propertyMap = new Map(allProperties.map((p) => [p.id, p]));

  // Build facts with their property metadata
  const factsWithProps: FactWithProperty[] = substantiveFacts.map((fact) => ({
    fact,
    property: propertyMap.get(fact.propertyId),
  }));

  // Group by category, then by property
  const byCategory = groupByCategory(factsWithProps);
  const categoryKeys = sortCategories(Object.keys(byCategory));

  // Hero stat properties for this entity type (KB entity types, not wiki entity types)
  const entityType = kbEntity?.type ?? "";
  const heroPropIds = HERO_STAT_PROPERTIES[entityType] ?? [];

  // Pre-compute latest facts for hero stats to avoid per-card data re-fetching
  const heroCards = heroPropIds
    .map((propId) => {
      const fact = getKBLatest(entityId, propId);
      if (!fact) return null;
      return { propId, fact, prop: propertyMap.get(propId) };
    })
    .filter((c): c is { propId: string; fact: Fact; prop: Property | undefined } => c != null);

  return (
    <section className="not-prose mt-8 mb-6" aria-labelledby="kb-auto-facts-heading">
      <div>
        {/* Header bar */}
        <div className="py-2 border-b border-border/60 flex items-center gap-2">
          <Database size={14} className="text-muted-foreground/60" />
          <h2 id="kb-auto-facts-heading" className="text-sm font-bold tracking-tight">
            Structured Data
          </h2>
          <span className="text-xs text-muted-foreground flex items-center gap-1.5 ml-1">
            {substantiveFacts.length > 0 && (
              <span>
                {substantiveFacts.length}{" "}
                {substantiveFacts.length === 1 ? "fact" : "facts"}
              </span>
            )}
          </span>
          <Link
            href={`/kb/entity/${entityId}`}
            className="ml-auto text-xs text-primary/60 hover:text-primary hover:underline transition-colors"
          >
            View full profile &rarr;
          </Link>
        </div>

        <div className="pt-3">
          {/* 1. Hero stat cards */}
          {heroCards.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
              {heroCards.map(({ propId, fact, prop }) => (
                <StatCard key={propId} propertyId={propId} fact={fact} prop={prop} />
              ))}
            </div>
          )}

          {/* 2. Category-grouped facts */}
          {substantiveFacts.length > 0 && (
            <>
              <SectionDivider title="All Facts" />
              {categoryKeys.map((category) => {
                const categoryFacts = byCategory[category];
                if (!categoryFacts || categoryFacts.length === 0) return null;

                const byProp = groupByProperty(categoryFacts);
                const propertyIds = Object.keys(byProp);

                return (
                  <div key={category} className="mb-3 last:mb-0">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/60 mb-1 pb-0.5 border-b border-border/40">
                      {titleCase(category)}
                    </div>
                    <table className="w-full">
                      <thead className="sr-only">
                        <tr>
                          <th scope="col">Property</th>
                          <th scope="col">Value</th>
                          <th scope="col">As Of</th>
                          <th scope="col">Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {propertyIds.map((propId) => {
                          const propItems = byProp[propId];
                          if (!propItems || propItems.length === 0) return null;

                          // Use time-series rendering if multiple dated facts
                          const isTimeSeries =
                            propItems.length > 1 &&
                            propItems.filter((i) => i.fact.asOf).length > 1;

                          if (isTimeSeries) {
                            return (
                              <TimeSeriesFactRow
                                key={propId}
                                propertyId={propId}
                                items={propItems}
                              />
                            );
                          }

                          return (
                            <SingleFactRow
                              key={propId}
                              propertyId={propId}
                              items={propItems}
                            />
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
