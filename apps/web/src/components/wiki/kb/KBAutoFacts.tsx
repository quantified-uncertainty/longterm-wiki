/**
 * KBAutoFacts -- Auto-rendered KB structured data section for entity pages.
 *
 * Server component that checks if an entity has substantive KB facts
 * (beyond just a description stub) and renders them in a card-like
 * collapsible section. Designed to be automatically included on entity
 * wiki pages without requiring manual MDX markup.
 *
 * Uses native HTML <details>/<summary> for collapsibility (no client JS needed).
 */

import {
  getKBFacts,
  getKBEntity,
  getKBProperties,
  getKBAllItemCollections,
  getKBAllRecordCollections,
  getKBSchema,
  isFactExpired,
} from "@data/kb";
import type { Fact, Property, ItemEntry, FieldDef } from "@longterm-wiki/kb";
import { formatKBDate, isUrl, shortDomain, titleCase } from "@components/wiki/kb/format";
import { KBFactValueDisplay } from "@components/wiki/kb/KBFactValueDisplay";
import { KBCellValue } from "@components/wiki/kb/KBCellValue";
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
    <span className="text-muted-foreground/30" title="No source URL">
      {"\u2014"}
    </span>
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

  // Sort by asOf descending
  const sorted = [...items].sort((a, b) => {
    if (!a.fact.asOf && !b.fact.asOf) return 0;
    if (!a.fact.asOf) return 1;
    if (!b.fact.asOf) return -1;
    return b.fact.asOf.localeCompare(a.fact.asOf);
  });

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

// ── Item collection defaults ─────────────────────────────────────────

/** Default columns per collection type, used when schema is unavailable. */
const DEFAULT_ITEM_COLUMNS: Record<string, string[]> = {
  "funding-rounds": ["date", "amount", "lead_investor"],
  "key-people": ["person", "title", "start"],
  products: ["name", "launched", "description"],
  "model-releases": ["name", "released", "description"],
  "board-members": ["name", "role", "appointed"],
  "strategic-partnerships": ["partner", "type", "date"],
  "safety-milestones": ["name", "date", "description"],
  "research-areas": ["name", "description", "started"],
  "grants-and-programs": ["name", "amount", "date"],
};

/** Excluded fields (metadata, not useful in summary view). */
const EXCLUDED_ITEM_FIELDS = new Set([
  "source",
  "notes",
  "key-publication",
  "key_publication",
]);

/** Resolve which columns to show for a collection. */
function resolveItemColumns(
  collectionName: string,
  items: ItemEntry[],
  fieldDefs?: Record<string, FieldDef>,
): string[] {
  const defaults = DEFAULT_ITEM_COLUMNS[collectionName];

  if (fieldDefs) {
    const schemaFields = Object.keys(fieldDefs).filter(
      (f) => !EXCLUDED_ITEM_FIELDS.has(f),
    );
    if (!defaults) return schemaFields;
    // Prefer defaults order, but only for columns actually in the schema
    const filtered = defaults.filter((f) => fieldDefs[f]);
    return filtered.length > 0 ? filtered : schemaFields;
  }

  if (defaults) return defaults;

  // Derive from actual data, excluding metadata
  const seen = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item.fields)) {
      if (!EXCLUDED_ITEM_FIELDS.has(key)) {
        seen.add(key);
      }
    }
  }
  return Array.from(seen).slice(0, 5); // Cap at 5 columns
}

/** Render a collapsible item collection. */
function ItemCollectionSection({
  collectionName,
  items,
  entityType,
}: {
  collectionName: string;
  items: ItemEntry[];
  entityType: string | undefined;
}) {
  const schema = entityType ? getKBSchema(entityType) : undefined;
  const collectionSchema = schema?.items?.[collectionName];
  const fieldDefs = collectionSchema?.fields;
  const cols = resolveItemColumns(collectionName, items, fieldDefs);

  return (
    <details className="group/item">
      <summary className="cursor-pointer select-none flex items-center gap-1.5 py-1.5 hover:bg-muted/30 transition-colors rounded px-1 -mx-1">
        <ChevronRight
          size={12}
          className="text-muted-foreground/60 transition-transform group-open/item:rotate-90 shrink-0"
        />
        <span className="text-sm text-foreground">
          {titleCase(collectionName)}
        </span>
        <span className="text-xs text-muted-foreground/60">
          ({items.length})
        </span>
      </summary>
      <div className="mt-1 mb-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/50">
              {cols.map((col) => (
                <th
                  key={col}
                  scope="col"
                  className="text-left text-xs font-medium text-muted-foreground/70 py-1 pr-3 whitespace-nowrap"
                >
                  {titleCase(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={item.key}
                className="border-b border-border/20 last:border-b-0"
              >
                {cols.map((col) => (
                  <td
                    key={col}
                    className="py-1 pr-3 text-sm align-baseline whitespace-normal"
                  >
                    <KBCellValue
                      value={item.fields[col]}
                      fieldName={col}
                      fieldDef={fieldDefs?.[col]}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function KBAutoFacts({ entityId }: KBAutoFactsProps) {
  const allFacts = getKBFacts(entityId);
  const kbEntity = getKBEntity(entityId);

  // Filter out description-only stubs
  const substantiveFacts = allFacts.filter(
    (f) => f.propertyId !== "description",
  );

  // Get item collections (items + records merged)
  const itemCollections = getKBAllItemCollections(entityId);
  const recordCollections = getKBAllRecordCollections(entityId);
  const allCollections = { ...itemCollections, ...recordCollections };
  const collectionNames = Object.keys(allCollections);
  const totalItems = collectionNames.reduce(
    (sum, name) => sum + (allCollections[name]?.length ?? 0),
    0,
  );

  // Don't render if no substantive facts and no items
  if (substantiveFacts.length === 0 && totalItems === 0) {
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

  // Open by default for entities with enough structured data
  const AUTO_OPEN_THRESHOLD_FACTS = 5;
  const AUTO_OPEN_THRESHOLD_ITEMS = 10;
  const defaultOpen =
    substantiveFacts.length >= AUTO_OPEN_THRESHOLD_FACTS ||
    totalItems >= AUTO_OPEN_THRESHOLD_ITEMS;

  return (
    <section className="not-prose mt-8 mb-6">
      <details
        className="group border border-border rounded-lg bg-card shadow-sm"
        open={defaultOpen || undefined}
      >
        <summary className="flex items-center gap-2.5 px-4 py-3 cursor-pointer select-none hover:bg-muted/40 transition-colors rounded-lg">
          <ChevronRight
            size={16}
            className="text-muted-foreground transition-transform group-open:rotate-90 shrink-0"
          />
          <Database size={14} className="text-muted-foreground/60 shrink-0" />
          <span className="text-sm font-semibold text-foreground">
            Structured Data
          </span>
          <span className="text-xs text-muted-foreground flex items-center gap-1.5 ml-1">
            {substantiveFacts.length > 0 && (
              <span>
                {substantiveFacts.length}{" "}
                {substantiveFacts.length === 1 ? "fact" : "facts"}
              </span>
            )}
            {substantiveFacts.length > 0 && totalItems > 0 && (
              <span className="text-muted-foreground/40">{"\u00B7"}</span>
            )}
            {totalItems > 0 && (
              <span>
                {totalItems} {totalItems === 1 ? "item" : "items"}
              </span>
            )}
          </span>
        </summary>

        <div className="px-4 pb-4 pt-2 border-t border-border/50">
          {/* Attribution + KB detail link */}
          <p className="text-xs text-muted-foreground/60 mb-3">
            Structured data for {entityName}.{" "}
            <Link
              href={`/kb/entity/${entityId}`}
              className="text-primary/60 hover:text-primary hover:underline"
            >
              View full KB profile →
            </Link>
          </p>

          {/* Facts table grouped by category */}
          {substantiveFacts.length > 0 && (
            <div className="mb-4 overflow-x-auto">
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
            </div>
          )}

          {/* Item collections */}
          {collectionNames.length > 0 && (
            <div>
              {substantiveFacts.length > 0 && (
                <div className="border-t border-border/40 pt-3 mt-1" />
              )}
              {/* Collection summary badges */}
              <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 text-xs text-muted-foreground/60">
                {collectionNames.map((name) => {
                  const count = allCollections[name]?.length ?? 0;
                  return (
                    <span key={name}>
                      {titleCase(name)}{" "}
                      <span className="text-muted-foreground/40">
                        ({count})
                      </span>
                    </span>
                  );
                })}
              </div>
              {/* Expandable collection tables */}
              {collectionNames.map((name) => {
                const items = allCollections[name];
                if (!items || items.length === 0) return null;

                return (
                  <ItemCollectionSection
                    key={name}
                    collectionName={name}
                    items={items}
                    entityType={kbEntity?.type}
                  />
                );
              })}
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
