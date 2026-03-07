/**
 * KBEntityFacts -- Renders all facts for a KB entity, grouped by property category.
 *
 * Server component that displays facts organized into sections (financial, people,
 * safety, etc.). Time-series facts (multiple values over time) render as compact
 * rows with date/value pairs. Single-value facts render as key-value pairs.
 * Ref values render as links to the referenced entity page.
 *
 * Usage in MDX:
 *   <KBEntityFacts entity="anthropic" />
 *   <KBEntityFacts entity="anthropic" categories={["financial", "safety"]} />
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getKBFacts, getKBEntity, getKBProperties } from "@data/kb";
import type { Fact, Property } from "@longterm-wiki/kb";
import { formatKBDate, isUrl, shortDomain, titleCase } from "./format";
import { KBFactValueDisplay } from "./KBFactValueDisplay";

interface KBEntityFactsProps {
  /** KB entity ID (e.g., "anthropic") */
  entity: string;
  /** Optional filter: only show facts in these categories */
  categories?: string[];
  /** Optional heading */
  title?: string;
}

/** A fact grouped with its property metadata. */
interface FactWithProperty {
  fact: Fact;
  property: Property | undefined;
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

/** Render a time-series property (multiple facts with asOf dates). */
function TimeSeriesProperty({
  propertyId,
  items,
}: {
  propertyId: string;
  items: FactWithProperty[];
}) {
  const prop = items[0]?.property;
  const label = prop?.name ?? titleCase(propertyId);

  // Sort by asOf descending
  const sorted = [...items].sort((a, b) => {
    if (!a.fact.asOf && !b.fact.asOf) return 0;
    if (!a.fact.asOf) return 1;
    if (!b.fact.asOf) return -1;
    return b.fact.asOf.localeCompare(a.fact.asOf);
  });

  return (
    <div className="mb-3">
      <div className="text-xs font-semibold text-muted-foreground mb-1.5">
        {label}
      </div>
      <div className="flex flex-col gap-1">
        {sorted.map((item) => (
          <div
            key={item.fact.id}
            className="flex items-baseline justify-between gap-3 py-0.5 border-b border-border/50 last:border-b-0"
          >
            <span className="text-xs text-muted-foreground whitespace-nowrap min-w-[60px]">
              {formatKBDate(item.fact.asOf)}
            </span>
            <span className="text-sm text-right">
              <KBFactValueDisplay fact={item.fact} property={prop} />
            </span>
            {item.fact.source && isUrl(item.fact.source) && (
              <a
                href={item.fact.source}
                className="text-xs text-primary/60 hover:text-primary hover:underline whitespace-nowrap"
                target="_blank"
                rel="noopener noreferrer"
              >
                {shortDomain(item.fact.source)}
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Render a single-value property (one fact, or a property without time series). */
function SingleValueProperty({
  propertyId,
  items,
}: {
  propertyId: string;
  items: FactWithProperty[];
}) {
  const prop = items[0]?.property;
  const label = prop?.name ?? titleCase(propertyId);
  const fact = items[0]?.fact;

  if (!fact) return null;

  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-border/50 last:border-b-0">
      <span className="text-xs text-muted-foreground min-w-[100px]">
        {label}
      </span>
      <div className="text-sm text-right flex items-center gap-2">
        <KBFactValueDisplay fact={fact} property={prop} />
        {fact.asOf && (
          <span className="text-xs text-muted-foreground/60">
            ({formatKBDate(fact.asOf)})
          </span>
        )}
      </div>
    </div>
  );
}

/** Sort categories in a stable, logical order. */
const CATEGORY_ORDER: Record<string, number> = {
  organization: 0,
  financial: 1,
  product: 2,
  people: 3,
  safety: 4,
  biographical: 5,
  other: 99,
};

function sortCategories(categories: string[]): string[] {
  return [...categories].sort((a, b) => {
    const orderA = CATEGORY_ORDER[a] ?? 50;
    const orderB = CATEGORY_ORDER[b] ?? 50;
    return orderA - orderB;
  });
}

export function KBEntityFacts({
  entity,
  categories,
  title,
}: KBEntityFactsProps) {
  const allFacts = getKBFacts(entity);
  const kbEntity = getKBEntity(entity);
  const allProperties = getKBProperties();
  const propertyMap = new Map(allProperties.map((p) => [p.id, p]));

  if (allFacts.length === 0) {
    return (
      <Card className="my-6">
        <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
          <CardTitle className="text-base">
            {title ?? `${kbEntity?.name ?? entity} Facts`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No facts available.</p>
        </CardContent>
      </Card>
    );
  }

  // Build facts with their property metadata
  const factsWithProps: FactWithProperty[] = allFacts.map((fact) => ({
    fact,
    property: propertyMap.get(fact.propertyId),
  }));

  // Group by category, then by property
  const byCategory = groupByCategory(factsWithProps);
  let categoryKeys = sortCategories(Object.keys(byCategory));

  // Filter categories if specified
  if (categories && categories.length > 0) {
    const allowed = new Set(categories);
    categoryKeys = categoryKeys.filter((c) => allowed.has(c));
  }

  return (
    <Card className="my-6">
      <CardHeader className="flex-row items-center gap-2 space-y-0 pb-4">
        <CardTitle className="text-base">
          {title ?? `${kbEntity?.name ?? entity} Facts`}
        </CardTitle>
        <span className="text-xs text-muted-foreground">
          {allFacts.length} {allFacts.length === 1 ? "fact" : "facts"}
        </span>
      </CardHeader>
      <CardContent>
        {categoryKeys.map((category) => {
          const categoryFacts = byCategory[category];
          if (!categoryFacts || categoryFacts.length === 0) return null;

          const byProperty = groupByProperty(categoryFacts);
          const propertyIds = Object.keys(byProperty);

          return (
            <div key={category} className="mb-4 last:mb-0">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/70 mb-2 pb-1 border-b border-border">
                {titleCase(category)}
              </div>
              {propertyIds.map((propId) => {
                const items = byProperty[propId];
                if (!items || items.length === 0) return null;

                // Use time-series rendering if there are multiple dated facts
                const isTimeSeries =
                  items.length > 1 &&
                  items.filter((i) => i.fact.asOf).length > 1;

                if (isTimeSeries) {
                  return (
                    <TimeSeriesProperty
                      key={propId}
                      propertyId={propId}
                      items={items}
                    />
                  );
                }

                return (
                  <SingleValueProperty
                    key={propId}
                    propertyId={propId}
                    items={items}
                  />
                );
              })}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
