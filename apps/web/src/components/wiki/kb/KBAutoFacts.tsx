/**
 * KBAutoFacts -- Auto-rendered KB facts section for entity pages.
 *
 * Server component that checks if an entity has substantive KB facts
 * (beyond just a description stub) and renders them in a collapsible
 * section. Designed to be automatically included on entity wiki pages
 * without requiring manual MDX markup.
 *
 * Uses native HTML <details>/<summary> for collapsibility (no client JS needed).
 */

import { getKBFacts, getKBEntity, getKBProperties } from "@data/kb";
import type { Fact, Property } from "@longterm-wiki/kb";
import { formatKBDate, titleCase } from "./format";
import { KBFactValueDisplay } from "./KBFactValueDisplay";
import { ChevronRight } from "lucide-react";

interface KBAutoFactsProps {
  /** Page slug / KB entity ID (e.g., "anthropic") */
  entityId: string;
}

/** A fact grouped with its property metadata. */
interface FactWithProperty {
  fact: Fact;
  property: Property | undefined;
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
function TimeSeriesRow({
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
    <div className="mb-2">
      <div className="text-xs font-medium text-muted-foreground mb-1">
        {label}
      </div>
      <div className="flex flex-col gap-0.5">
        {sorted.map((item) => (
          <div
            key={item.fact.id}
            className="flex items-baseline justify-between gap-3 py-0.5 text-sm"
          >
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {formatKBDate(item.fact.asOf)}
            </span>
            <span className="text-right">
              <KBFactValueDisplay fact={item.fact} property={prop} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Render a single-value property. */
function SingleValueRow({
  propertyId,
  items,
}: {
  propertyId: string;
  items: FactWithProperty[];
}) {
  // Prefer currently-active facts (validEnd == null), then sort by asOf descending
  const candidates = items.some((item) => !item.fact.validEnd)
    ? items.filter((item) => !item.fact.validEnd)
    : items;
  const sorted = [...candidates].sort((a, b) => {
    if (!a.fact.asOf && !b.fact.asOf) return 0;
    if (!a.fact.asOf) return 1;
    if (!b.fact.asOf) return -1;
    return b.fact.asOf.localeCompare(a.fact.asOf);
  });
  const prop = sorted[0]?.property;
  const label = prop?.name ?? titleCase(propertyId);
  const fact = sorted[0]?.fact;

  if (!fact) return null;

  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-xs text-muted-foreground shrink-0">
        {label}
      </span>
      <span className="text-right flex items-center gap-1.5">
        <KBFactValueDisplay fact={fact} property={prop} />
        {fact.asOf && (
          <span className="text-xs text-muted-foreground/60">
            ({formatKBDate(fact.asOf)})
          </span>
        )}
      </span>
    </div>
  );
}

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

  const entityName = kbEntity?.name ?? entityId;

  return (
    <section className="not-prose mt-8 mb-6">
      <details className="group border border-border rounded-lg">
        <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none hover:bg-muted/40 transition-colors rounded-lg">
          <ChevronRight
            size={16}
            className="text-muted-foreground transition-transform group-open:rotate-90 shrink-0"
          />
          <span className="text-sm font-semibold text-foreground">
            Knowledge Base Facts
          </span>
          <span className="text-xs text-muted-foreground">
            {substantiveFacts.length}{" "}
            {substantiveFacts.length === 1 ? "fact" : "facts"}
          </span>
        </summary>

        <div className="px-4 pb-4 pt-1 border-t border-border/50">
          <p className="text-xs text-muted-foreground mb-3">
            Structured data for {entityName} from the{" "}
            <span className="font-mono text-xs">kb:{entityId}</span> knowledge
            base.
          </p>

          {categoryKeys.map((category) => {
            const categoryFacts = byCategory[category];
            if (!categoryFacts || categoryFacts.length === 0) return null;

            const byProperty = groupByProperty(categoryFacts);
            const propertyIds = Object.keys(byProperty);

            return (
              <div key={category} className="mb-3 last:mb-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/70 mb-1.5 pb-0.5 border-b border-border/60">
                  {titleCase(category)}
                </div>
                <div className="divide-y divide-border/30">
                  {propertyIds.map((propId) => {
                    const items = byProperty[propId];
                    if (!items || items.length === 0) return null;

                    // Use time-series rendering if there are multiple dated facts
                    const isTimeSeries =
                      items.length > 1 &&
                      items.filter((i) => i.fact.asOf).length > 1;

                    if (isTimeSeries) {
                      return (
                        <TimeSeriesRow
                          key={propId}
                          propertyId={propId}
                          items={items}
                        />
                      );
                    }

                    return (
                      <SingleValueRow
                        key={propId}
                        propertyId={propId}
                        items={items}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </details>
    </section>
  );
}
