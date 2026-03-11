/**
 * KBAutoFacts -- Auto-rendered KB structured data section for entity pages.
 *
 * Server component that checks if an entity has substantive KB facts
 * (beyond just a description stub) and renders them in a visually rich
 * section with hero stat cards, person cards, funding timeline, and
 * categorized fact tables. Designed to be automatically included on entity
 * wiki pages without requiring manual MDX markup.
 */

import {
  getKBFacts,
  getKBEntity,
  getKBProperties,
  getKBLatest,
  getKBAllRecordCollections,
  getKBRecordSchema,
  isFactExpired,
} from "@data/kb";
import type { Fact, Property, RecordEntry, RecordSchema, FieldDef } from "@longterm-wiki/kb";
import { formatKBDate, isUrl, shortDomain, sortKBRecords, titleCase } from "@components/wiki/kb/format";
import { KBFactValueDisplay } from "@components/wiki/kb/KBFactValueDisplay";
import { KBCellValue } from "@components/wiki/kb/KBCellValue";
import { KBRefLink } from "@components/wiki/kb/KBRefLink";
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
  project: ["developed-by", "parameter-count", "context-window", "model-release-date"],
};

/** Collections that get dedicated visual renderers. */
const SPECIAL_COLLECTIONS = new Set([
  "key-persons",
  "funding-rounds",
  "model-releases",
  "products",
]);

/** Default columns per collection type, used when schema is unavailable. */
const DEFAULT_RECORD_COLUMNS: Record<string, string[]> = {
  "funding-rounds": ["date", "raised", "lead_investor"],
  "key-persons": ["person", "title", "start"],
  products: ["name", "launched", "description"],
  "model-releases": ["name", "released", "description"],
  "board-seats": ["member", "role", "appointed"],
  "charitable-pledges": ["pledger", "pledge"],
  "equity-positions": ["holder", "stake"],
  "investments": ["investor", "round_name", "date", "amount", "stake_acquired", "role"],
  "strategic-partnerships": ["partner", "type", "date", "investment_amount"],
  "safety-milestones": ["name", "date", "description"],
  "research-areas": ["name", "description", "started"],
  grants: ["name", "amount", "date"],
};

/** Excluded fields (metadata, not useful in summary view). */
const EXCLUDED_RECORD_FIELDS = new Set([
  "source",
  "notes",
  "key-publication",
  "key_publication",
]);

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

/** Safely extract a string field from a record entry. */
function field(item: RecordEntry, key: string): string | undefined {
  const v = item.fields[key];
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined; // Don't coerce arrays/objects
}

/** Format a currency amount compactly. */
function formatAmount(value: unknown): string | null {
  if (value == null) return null;
  const num = typeof value === "number" ? value : Number(value);
  if (isNaN(num)) return String(value);
  if (num >= 1e9) return `$${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(0)}M`;
  return `$${num.toLocaleString()}`;
}

/** Resolve which columns to show for a collection, including explicit endpoints. */
function resolveRecordColumns(
  collectionName: string,
  items: RecordEntry[],
  schema?: RecordSchema,
): string[] {
  const defaults = DEFAULT_RECORD_COLUMNS[collectionName];
  const fieldDefs = schema?.fields;

  // Collect explicit endpoint names (e.g. "holder", "pledger", "investor")
  // Only include if at least one item actually has the field populated
  const explicitEndpoints: string[] = [];
  if (schema?.endpoints) {
    for (const [name, ep] of Object.entries(schema.endpoints)) {
      if (!ep.implicit && items.some((item) => item.fields[name] != null)) {
        explicitEndpoints.push(name);
      }
    }
  }

  if (fieldDefs) {
    const schemaFields = Object.keys(fieldDefs).filter(
      (f) => !EXCLUDED_RECORD_FIELDS.has(f),
    );
    // Put explicit endpoints first, then schema fields
    const allCols = [...explicitEndpoints, ...schemaFields];
    if (!defaults) return allCols;
    // Prefer defaults order, but only for columns actually available
    const available = new Set(allCols);
    const filtered = defaults.filter((f) => available.has(f));
    return filtered.length > 0 ? filtered : allCols;
  }

  if (defaults) return [...explicitEndpoints, ...defaults.filter((d) => !explicitEndpoints.includes(d))];

  // Derive from actual data, excluding metadata
  const seen = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item.fields)) {
      if (!EXCLUDED_RECORD_FIELDS.has(key)) {
        seen.add(key);
      }
    }
  }
  return Array.from(seen).slice(0, 6); // Cap at 6 columns
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

/** Person card for key-persons collection. */
function PersonCard({ item }: { item: RecordEntry }) {
  const personId = field(item, "person");
  const personEntity = personId ? getKBEntity(personId) : null;
  const name = personEntity?.name ?? field(item, "display_name") ?? titleCase(item.key);
  const title = field(item, "title");
  const start = field(item, "start");
  const end = field(item, "end");
  const isFounder = !!item.fields.is_founder;

  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="group relative rounded-lg border border-border/50 bg-card px-2.5 py-2 transition-all hover:shadow-sm hover:border-border">
      <div className="flex items-center gap-2">
        <div className="shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-primary/15 to-primary/5 flex items-center justify-center text-[10px] font-semibold text-primary/60">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            {personId ? (
              <KBRefLink id={personId} className="font-semibold text-sm leading-tight text-foreground group-hover:text-primary transition-colors" />
            ) : (
              <span className="font-semibold text-sm leading-tight">{name}</span>
            )}
            {isFounder && (
              <span className="inline-flex items-center px-1.5 py-px rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                Founder
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground leading-tight">
            {title}{title && start ? " · " : ""}
            {start && (
              <span className="text-muted-foreground/50">
                {formatKBDate(start)}
                {end ? `\u2013${formatKBDate(end)}` : "\u2013present"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Funding round row for timeline display. */
function FundingRoundRow({ item }: { item: RecordEntry }) {
  const name = field(item, "name") ?? titleCase(item.key);
  const date = field(item, "date");
  const raised = item.fields.raised;
  const valuation = item.fields.valuation;
  const leadInvestor = field(item, "lead_investor");
  const instrument = field(item, "instrument");
  const source = field(item, "source");

  return (
    <div className="py-1.5 border-b border-border/30 last:border-b-0">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-semibold text-sm">{name}</span>
        {instrument && (
          <span className="text-[10px] px-1.5 py-px rounded-full bg-muted text-muted-foreground font-medium">
            {instrument}
          </span>
        )}
        {date && (
          <span className="text-xs text-muted-foreground/60">
            {formatKBDate(date)}
          </span>
        )}
        {raised != null && (
          <span className="text-sm font-bold tabular-nums tracking-tight">
            {formatAmount(raised)}
          </span>
        )}
        {valuation != null && (
          <span className="text-xs text-muted-foreground">
            at {formatAmount(valuation)} valuation
          </span>
        )}
      </div>
      {(leadInvestor || (source && isUrl(source))) && (
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
          {leadInvestor && (
            <span>Led by <KBRefLink id={leadInvestor} /></span>
          )}
          {source && isUrl(source) && (
            <a
              href={source}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary/40 hover:text-primary hover:underline transition-colors"
            >
              {shortDomain(source)}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** Product card. */
function ProductCard({ item }: { item: RecordEntry }) {
  const name = field(item, "name") ?? titleCase(item.key);
  const launched = field(item, "launched");
  const description = field(item, "description");
  const source = field(item, "source");

  return (
    <div className="group rounded-xl border border-border/60 bg-card p-3.5 transition-all hover:shadow-md hover:border-border">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-sm group-hover:text-primary transition-colors">
          {name}
        </span>
        {launched && (
          <span className="text-[10px] text-muted-foreground/60">
            {formatKBDate(launched)}
          </span>
        )}
      </div>
      {description && (
        <div className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
          {description}
        </div>
      )}
      {source && isUrl(source) && (
        <a
          href={source}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-primary/50 hover:text-primary hover:underline mt-1 inline-block transition-colors"
        >
          {shortDomain(source)}
        </a>
      )}
    </div>
  );
}

/** Model release row. */
function ModelReleaseRow({ item }: { item: RecordEntry }) {
  const name = field(item, "name") ?? titleCase(item.key);
  const released = field(item, "released");
  const description = field(item, "description");
  const safetyLevel = field(item, "safety_level");

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border/50 last:border-b-0">
      <div className="min-w-[65px] text-xs text-muted-foreground pt-0.5">
        {released ? formatKBDate(released) : "\u2014"}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-medium text-sm">{name}</span>
          {safetyLevel && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {safetyLevel}
            </span>
          )}
        </div>
        {description && (
          <div className="text-xs text-muted-foreground mt-0.5">
            {description}
          </div>
        )}
      </div>
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

/** Render a record collection as a table (generic fallback). */
function RecordCollectionSection({
  collectionName,
  items,
}: {
  collectionName: string;
  items: RecordEntry[];
}) {
  const recordSchema = items[0] ? getKBRecordSchema(items[0].schema) : undefined;
  const fieldDefs = recordSchema?.fields;
  const cols = resolveRecordColumns(collectionName, items, recordSchema);

  // Build set of endpoint column names for entity-ref rendering
  const endpointCols = new Set<string>();
  if (recordSchema?.endpoints) {
    for (const [name, ep] of Object.entries(recordSchema.endpoints)) {
      if (!ep.implicit) endpointCols.add(name);
    }
  }

  return (
    <div className="mt-4">
      <SectionDivider title={titleCase(collectionName)} count={items.length} />
      <div className="overflow-x-auto border border-border/40 rounded-xl">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/50 bg-muted/20">
              {cols.map((col) => (
                <th
                  key={col}
                  scope="col"
                  className="text-left text-xs font-medium text-muted-foreground/70 py-1.5 px-3 whitespace-nowrap"
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
                    className="py-1.5 px-3 text-sm align-baseline whitespace-normal"
                  >
                    {endpointCols.has(col) && typeof item.fields[col] === "string" ? (
                      <KBRefLink id={item.fields[col] as string} />
                    ) : (
                      <KBCellValue
                        value={item.fields[col]}
                        fieldName={col}
                        fieldDef={fieldDefs?.[col]}
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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

  // Get record collections
  const allCollections = getKBAllRecordCollections(entityId);
  const collectionNames = Object.keys(allCollections);
  const totalRecords = collectionNames.reduce(
    (sum, name) => sum + (allCollections[name]?.length ?? 0),
    0,
  );

  // Don't render if no substantive facts and no records
  if (substantiveFacts.length === 0 && totalRecords === 0) {
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

  // Extract special collections
  const keyPersons = allCollections["key-persons"];
  const fundingRounds = allCollections["funding-rounds"];
  const modelReleases = allCollections["model-releases"];
  const products = allCollections["products"];

  const sortedFundingRounds = fundingRounds ? sortKBRecords(fundingRounds, "date", false) : [];
  const sortedModelReleases = modelReleases ? sortKBRecords(modelReleases, "released", false) : [];

  // Generic collections = everything not in SPECIAL_COLLECTIONS
  const genericCollections = Object.entries(allCollections)
    .filter(([name]) => !SPECIAL_COLLECTIONS.has(name))
    .sort(([a], [b]) => a.localeCompare(b));

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
            {substantiveFacts.length > 0 && totalRecords > 0 && (
              <span className="text-muted-foreground/40">{"\u00B7"}</span>
            )}
            {totalRecords > 0 && (
              <span>
                {totalRecords} {totalRecords === 1 ? "record" : "records"}
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

          {/* 2. Key People */}
          {keyPersons && keyPersons.length > 0 && (
            <>
              <SectionDivider title="Key People" count={keyPersons.length} />
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {keyPersons.map((item) => (
                  <PersonCard key={item.key} item={item} />
                ))}
              </div>
            </>
          )}

          {/* 3. Funding History */}
          {sortedFundingRounds.length > 0 && (
            <>
              <SectionDivider
                title="Funding History"
                count={sortedFundingRounds.length}
              />
              <div className="border border-border/40 rounded-xl px-4 bg-card">
                {sortedFundingRounds.map((item) => (
                  <FundingRoundRow key={item.key} item={item} />
                ))}
              </div>
            </>
          )}

          {/* 4. Model Releases */}
          {sortedModelReleases.length > 0 && (
            <>
              <SectionDivider
                title="Model Releases"
                count={sortedModelReleases.length}
              />
              <div className="border border-border/40 rounded-xl px-4 bg-card">
                {sortedModelReleases.map((item) => (
                  <ModelReleaseRow key={item.key} item={item} />
                ))}
              </div>
            </>
          )}

          {/* 5. Products */}
          {products && products.length > 0 && (
            <>
              <SectionDivider title="Products" count={products.length} />
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {products.map((item) => (
                  <ProductCard key={item.key} item={item} />
                ))}
              </div>
            </>
          )}

          {/* 6. Category-grouped facts */}
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

          {/* 7. Other collections (generic table) */}
          {genericCollections.map(([name, items]) => {
            if (!items || items.length === 0) return null;
            return (
              <RecordCollectionSection
                key={name}
                collectionName={name}
                items={items}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}
