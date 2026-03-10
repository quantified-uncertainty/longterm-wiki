import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";

import {
  getKBEntities,
  getKBEntity,
  getKBFacts,
  getKBAllRecordCollections,
  getKBProperty,
  getKBRecordSchema,
  getKBLatest,
} from "@/data/kb";
import { getEntityHref } from "@/data";
import type { Fact, Property, RecordEntry } from "@longterm-wiki/kb";
import {
  formatKBFactValue,
  formatKBDate,
  formatKBCellValue,
  shortDomain,
  titleCase,
  isUrl,
} from "@/components/wiki/kb/format";

import {
  WikiSidebar,
  MobileSidebarTrigger,
} from "@/components/wiki/WikiSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { getKBDataNav } from "@/lib/wiki-nav";
import { fetchFromWikiServer } from "@/lib/wiki-server";

// ─── Verification types & helpers ────────────────────────────────────

type VerdictType = "confirmed" | "contradicted" | "unverifiable" | "outdated" | "partial" | "unchecked";

interface VerdictRow {
  factId: string;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sourcesChecked: number | null;
  needsRecheck: boolean | null;
  lastComputedAt: string | null;
}

interface VerdictsResponse {
  verdicts: VerdictRow[];
  total: number;
}

async function fetchEntityVerdicts(entityId: string): Promise<Map<string, VerdictRow>> {
  const data = await fetchFromWikiServer<VerdictsResponse>(
    `/api/kb-verifications/verdicts?entity_id=${encodeURIComponent(entityId)}&limit=200`,
    { revalidate: 300 }
  );
  const map = new Map<string, VerdictRow>();
  if (data) {
    for (const v of data.verdicts) {
      map.set(v.factId, v);
    }
  }
  return map;
}

const VERDICT_STYLES: Record<VerdictType, { label: string; className: string }> = {
  confirmed:    { label: "Confirmed",    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  contradicted: { label: "Contradicted", className: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300" },
  outdated:     { label: "Outdated",     className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
  partial:      { label: "Partial",      className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
  unverifiable: { label: "Unverifiable", className: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
  unchecked:    { label: "Unchecked",    className: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" },
};

function VerdictBadge({ verdict }: { verdict: VerdictRow }) {
  const style = VERDICT_STYLES[verdict.verdict as VerdictType] ?? VERDICT_STYLES.unchecked;
  const confidence = verdict.confidence != null ? Math.round(verdict.confidence * 100) : null;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight ${style.className}`}
      title={verdict.reasoning ?? undefined}
    >
      {style.label}
      {confidence != null && <span className="opacity-70">{confidence}%</span>}
    </span>
  );
}

function verdictSummary(verdicts: Map<string, VerdictRow>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of verdicts.values()) {
    counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
  }
  return counts;
}

// ─── Static params & metadata ────────────────────────────────────────

export function generateStaticParams() {
  return getKBEntities().map((entity) => ({ entityId: entity.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ entityId: string }>;
}): Promise<Metadata> {
  const { entityId } = await params;
  const entity = getKBEntity(entityId);
  return {
    title: entity ? `KB: ${entity.name}` : `KB: ${entityId}`,
  };
}

// ─── Data helpers ────────────────────────────────────────────────────

/** Group facts by propertyId, excluding "description". */
function groupFactsByProperty(facts: Fact[]): Map<string, Fact[]> {
  const groups = new Map<string, Fact[]>();
  for (const fact of facts) {
    if (fact.propertyId === "description") continue;
    const list = groups.get(fact.propertyId) ?? [];
    list.push(fact);
    groups.set(fact.propertyId, list);
  }
  for (const [, list] of groups) {
    list.sort((a, b) => {
      if (a.asOf === undefined && b.asOf === undefined) return 0;
      if (a.asOf === undefined) return 1;
      if (b.asOf === undefined) return -1;
      return b.asOf.localeCompare(a.asOf);
    });
  }
  return groups;
}

/** Group property IDs by their category. */
function groupByCategory(
  propertyIds: string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const propId of propertyIds) {
    const prop = getKBProperty(propId);
    const category = prop?.category ?? "other";
    const list = groups.get(category) ?? [];
    list.push(propId);
    groups.set(category, list);
  }
  return groups;
}

const CATEGORY_ORDER: Record<string, number> = {
  financial: 0,
  product: 1,
  organization: 2,
  safety: 3,
  people: 4,
  biographical: 5,
  model: 6,
  risk: 7,
  epistemic: 8,
  approach: 9,
  other: 99,
};

const CATEGORY_LABELS: Record<string, string> = {
  financial: "Financial",
  product: "Products & Usage",
  organization: "Organization",
  safety: "Safety & Research",
  people: "People",
  biographical: "Background",
  model: "Model Details",
  risk: "Risk Assessment",
  epistemic: "Epistemic Status",
  approach: "Approach",
  other: "Other",
};

/** Properties to show as hero stat cards (order matters). */
const HERO_STAT_PROPERTIES: Record<string, string[]> = {
  organization: ["revenue", "valuation", "headcount", "total-funding", "enterprise-market-share", "founded-date"],
  person: ["employed-by", "role", "net-worth", "born-year"],
  "ai-model": ["developed-by", "parameter-count", "context-window", "model-release-date"],
};

/** Collections that get special rendering. */
const SPECIAL_COLLECTIONS = new Set([
  "key-persons",
  "funding-rounds",
  "model-releases",
  "products",
]);

// ─── Sub-components ──────────────────────────────────────────────────

function SourceCell({ fact }: { fact: Fact }) {
  if (fact.source) {
    if (isUrl(fact.source)) {
      return (
        <a
          href={fact.source}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          {shortDomain(fact.source)}
        </a>
      );
    }
    return <span className="text-xs text-muted-foreground">{fact.source}</span>;
  }
  return <span className="text-muted-foreground">&mdash;</span>;
}

function FactValueDisplay({ fact, property }: { fact: Fact; property?: Property }) {
  const v = fact.value;
  if (v.type === "ref") {
    const refEntity = getKBEntity(v.value);
    return (
      <Link href={`/kb/entity/${v.value}`} className="text-blue-600 hover:underline dark:text-blue-400">
        {refEntity?.name ?? v.value}
      </Link>
    );
  }
  if (v.type === "refs") {
    return (
      <span>
        {v.value.map((refId, i) => {
          const refEntity = getKBEntity(refId);
          return (
            <span key={`${refId}-${i}`}>
              {i > 0 && ", "}
              <Link href={`/kb/entity/${refId}`} className="text-blue-600 hover:underline dark:text-blue-400">
                {refEntity?.name ?? refId}
              </Link>
            </span>
          );
        })}
      </span>
    );
  }
  return <span>{formatKBFactValue(fact, property?.unit, property?.display)}</span>;
}

/** Hero stat card for a key metric. */
function StatCard({ entityId, propertyId }: { entityId: string; propertyId: string }) {
  const fact = getKBLatest(entityId, propertyId);
  const prop = getKBProperty(propertyId);
  if (!fact) return null;

  return (
    <div className="border border-border rounded-lg p-3 bg-card">
      <div className="text-xs text-muted-foreground mb-1">
        {prop?.name ?? titleCase(propertyId)}
      </div>
      <div className="text-lg font-semibold tabular-nums">
        <FactValueDisplay fact={fact} property={prop} />
      </div>
      {fact.asOf && (
        <div className="text-[10px] text-muted-foreground/60 mt-0.5">
          as of {formatKBDate(fact.asOf)}
        </div>
      )}
    </div>
  );
}

/** Safely get a string field from a record, or undefined. */
function field(item: RecordEntry, key: string): string | undefined {
  const v = item.fields[key];
  if (v == null) return undefined;
  return String(v);
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
  const notes = field(item, "notes");

  return (
    <div className="border border-border rounded-lg p-3 bg-card flex flex-col gap-1">
      <div className="flex items-start justify-between gap-2">
        <div>
          {personEntity && personId ? (
            <Link href={`/kb/entity/${personId}`} className="font-medium text-sm text-blue-600 hover:underline dark:text-blue-400">
              {name}
            </Link>
          ) : (
            <span className="font-medium text-sm">{name}</span>
          )}
          {isFounder && (
            <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary">
              Founder
            </span>
          )}
        </div>
      </div>
      {title && <div className="text-xs text-muted-foreground">{title}</div>}
      <div className="text-[10px] text-muted-foreground/60">
        {start && formatKBDate(start)}
        {end ? ` \u2013 ${formatKBDate(end)}` : start ? " \u2013 present" : ""}
      </div>
      {notes && <div className="text-[10px] text-muted-foreground/60 mt-0.5 line-clamp-2">{notes}</div>}
    </div>
  );
}

/** Format a currency amount for display. */
function formatAmount(value: unknown): string | null {
  if (value == null) return null;
  const num = typeof value === "number" ? value : Number(value);
  if (isNaN(num)) return String(value);
  if (num >= 1e9) return `$${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(0)}M`;
  return `$${num.toLocaleString()}`;
}

/** Funding round row for timeline display. */
function FundingRoundRow({ item }: { item: RecordEntry }) {
  const name = field(item, "name") ?? titleCase(item.key);
  const date = field(item, "date");
  const raised = item.fields.raised;
  const valuation = item.fields.valuation;
  const leadInvestor = field(item, "lead_investor");
  const instrument = field(item, "instrument");
  const notes = field(item, "notes");
  const source = field(item, "source");

  const leadEntity = leadInvestor ? getKBEntity(leadInvestor) : null;

  return (
    <div className="flex gap-3 py-3 border-b border-border/50 last:border-b-0">
      {/* Timeline dot + date */}
      <div className="flex flex-col items-center pt-0.5">
        <div className="w-2.5 h-2.5 rounded-full bg-primary/60 shrink-0" />
        <div className="w-px flex-1 bg-border/50 mt-1" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-medium text-sm">{name}</span>
          {instrument && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {instrument}
            </span>
          )}
          {date && <span className="text-xs text-muted-foreground">{formatKBDate(date)}</span>}
        </div>
        <div className="flex items-baseline gap-4 mt-1 flex-wrap">
          {raised != null && (
            <span className="text-sm font-semibold tabular-nums">
              {formatAmount(raised)}
            </span>
          )}
          {valuation != null && (
            <span className="text-xs text-muted-foreground">
              at {formatAmount(valuation)}
            </span>
          )}
          {leadInvestor && (
            <span className="text-xs text-muted-foreground">
              Led by{" "}
              {leadEntity ? (
                <Link href={`/kb/entity/${leadInvestor}`} className="text-blue-600 hover:underline dark:text-blue-400">
                  {leadEntity.name}
                </Link>
              ) : (
                leadInvestor
              )}
            </span>
          )}
        </div>
        {notes && <div className="text-[10px] text-muted-foreground/60 mt-1 line-clamp-2">{notes}</div>}
        {source && isUrl(source) && (
          <a href={source} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-600/60 hover:underline dark:text-blue-400/60 mt-0.5 inline-block">
            {shortDomain(source)}
          </a>
        )}
      </div>
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
    <div className="border border-border rounded-lg p-3 bg-card">
      <div className="flex items-baseline gap-2">
        <span className="font-medium text-sm">{name}</span>
        {launched && (
          <span className="text-[10px] text-muted-foreground">{formatKBDate(launched)}</span>
        )}
      </div>
      {description && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{description}</div>}
      {source && isUrl(source) && (
        <a href={source} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-600/60 hover:underline dark:text-blue-400/60 mt-1 inline-block">
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
      <div className="min-w-[70px] text-xs text-muted-foreground pt-0.5">
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
        {description && <div className="text-xs text-muted-foreground mt-0.5">{description}</div>}
      </div>
    </div>
  );
}

/** Section header with optional count badge. */
function SectionHeader({ title, count, id }: { title: string; count?: number; id?: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-3" id={id}>
      <h2 className="text-base font-semibold">{title}</h2>
      {count != null && (
        <span className="text-xs text-muted-foreground">({count})</span>
      )}
    </div>
  );
}

/** Category section for grouped facts. */
function CategoryFactSection({
  category,
  propertyIds,
  factGroups,
  verdicts,
}: {
  category: string;
  propertyIds: string[];
  factGroups: Map<string, Fact[]>;
  verdicts: Map<string, VerdictRow>;
}) {
  return (
    <section className="mb-6">
      <SectionHeader
        title={CATEGORY_LABELS[category] ?? titleCase(category)}
        id={`cat-${category}`}
      />
      <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
        {propertyIds.map((propertyId) => {
          const facts = factGroups.get(propertyId) ?? [];
          if (facts.length === 0) return null;
          const property = getKBProperty(propertyId);
          const latestFact = facts[0];

          return (
            <details key={propertyId} id={propertyId} className="group scroll-mt-16">
              <summary className="flex items-center gap-4 px-4 py-2.5 cursor-pointer hover:bg-muted/50 text-sm select-none">
                <span className="font-medium min-w-[10rem]">
                  {property?.name ?? propertyId}
                </span>
                <span className="flex-1 text-muted-foreground truncate font-mono">
                  {formatKBFactValue(latestFact, property?.unit, property?.display)}
                </span>
                <span className="text-muted-foreground text-xs whitespace-nowrap">
                  {formatKBDate(latestFact.asOf)}
                </span>
                {facts.length > 1 && (
                  <span className="text-muted-foreground text-xs whitespace-nowrap">
                    {facts.length} pts
                  </span>
                )}
                <span className="text-muted-foreground text-xs group-open:rotate-90 transition-transform">
                  &#9654;
                </span>
              </summary>

              <div className="px-4 pb-3 pt-1 bg-muted/20">
                <div className="mb-2">
                  <Link
                    href={`/kb/property/${propertyId}`}
                    className="text-blue-600 hover:underline dark:text-blue-400 text-xs"
                  >
                    View property &rarr;
                  </Link>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="text-left py-1 pr-3 font-medium">As Of</th>
                      <th className="text-left py-1 pr-3 font-medium">Value</th>
                      <th className="text-left py-1 pr-3 font-medium">Source</th>
                      {verdicts.size > 0 && (
                        <th className="text-left py-1 pr-3 font-medium">Verified</th>
                      )}
                      <th className="text-left py-1 font-medium">Fact ID</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {facts.map((fact) => {
                      const verdict = verdicts.get(fact.id);
                      return (
                        <tr key={fact.id} id={fact.id} className="scroll-mt-16">
                          <td className="py-1.5 pr-3 text-muted-foreground whitespace-nowrap">
                            {formatKBDate(fact.asOf)}
                          </td>
                          <td className="py-1.5 pr-3">
                            <FactValueDisplay fact={fact} property={property} />
                          </td>
                          <td className="py-1.5 pr-3">
                            <SourceCell fact={fact} />
                          </td>
                          {verdicts.size > 0 && (
                            <td className="py-1.5 pr-3">
                              {verdict ? (
                                <VerdictBadge verdict={verdict} />
                              ) : (
                                <span className="text-xs text-muted-foreground">&mdash;</span>
                              )}
                            </td>
                          )}
                          <td className="py-1.5">
                            <Link
                              href={`/kb/fact/${fact.id}`}
                              className="text-blue-600 hover:underline dark:text-blue-400 font-mono text-xs"
                            >
                              {fact.id}
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

/** Generic collection table (for collections without special rendering). */
function GenericCollectionTable({
  collectionName,
  items,
}: {
  collectionName: string;
  items: RecordEntry[];
}) {
  const recordSchema = items[0] ? getKBRecordSchema(items[0].schema) : undefined;
  const fieldDefs = recordSchema?.fields;

  const schemaFieldNames = fieldDefs ? Object.keys(fieldDefs) : [];
  const allFieldNames = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item.fields)) {
      allFieldNames.add(key);
    }
  }
  const columns = schemaFieldNames.length > 0
    ? [...schemaFieldNames, ...[...allFieldNames].filter((f) => !schemaFieldNames.includes(f))]
    : [...allFieldNames];

  return (
    <section className="mb-6">
      <SectionHeader title={titleCase(collectionName)} count={items.length} id={`col-${collectionName}`} />
      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              {columns.map((col) => (
                <th key={col} className="text-left py-1.5 px-3 font-medium">
                  {titleCase(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {items.map((item) => (
              <tr key={item.key}>
                {columns.map((col) => {
                  const cellValue = item.fields[col];
                  const fieldDef = fieldDefs?.[col];

                  if (fieldDef?.type === "ref" && typeof cellValue === "string") {
                    const refEntity = getKBEntity(cellValue);
                    return (
                      <td key={col} className="py-1.5 px-3">
                        <Link href={`/kb/entity/${cellValue}`} className="text-blue-600 hover:underline dark:text-blue-400">
                          {refEntity?.name ?? cellValue}
                        </Link>
                      </td>
                    );
                  }

                  if (typeof cellValue === "string" && isUrl(cellValue)) {
                    return (
                      <td key={col} className="py-1.5 px-3">
                        <a href={cellValue} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
                          {shortDomain(cellValue)}
                        </a>
                      </td>
                    );
                  }

                  return (
                    <td key={col} className="py-1.5 px-3">
                      {formatKBCellValue(cellValue, fieldDef)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function VerificationSummary({
  verdicts,
  totalFacts,
}: {
  verdicts: Map<string, VerdictRow>;
  totalFacts: number;
}) {
  const counts = verdictSummary(verdicts);
  const checked = verdicts.size;
  const unchecked = totalFacts - checked;

  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">
        {checked}/{totalFacts} checked
      </span>
      {(["confirmed", "contradicted", "outdated", "partial", "unverifiable"] as const).map(
        (v) =>
          counts[v] ? (
            <span
              key={v}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium leading-tight ${VERDICT_STYLES[v].className}`}
            >
              {counts[v]} {VERDICT_STYLES[v].label.toLowerCase()}
            </span>
          ) : null,
      )}
      {unchecked > 0 && (
        <span className="text-muted-foreground">{unchecked} unchecked</span>
      )}
    </span>
  );
}

// ─── Page component ──────────────────────────────────────────────────

export default async function KBEntityPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  const entity = getKBEntity(entityId);
  if (!entity) return notFound();

  const allFacts = getKBFacts(entityId);
  const structuredFacts = allFacts.filter((f) => f.propertyId !== "description");
  const factGroups = groupFactsByProperty(allFacts);
  const itemCollections = getKBAllRecordCollections(entityId);
  const verdicts = await fetchEntityVerdicts(entityId);

  // Sort property groups alphabetically within each category
  const sortedPropertyIds = [...factGroups.keys()].sort((a, b) => {
    const pA = getKBProperty(a);
    const pB = getKBProperty(b);
    return (pA?.name ?? a).localeCompare(pB?.name ?? b);
  });

  // Group by category
  const categoryGroups = groupByCategory(sortedPropertyIds);
  const sortedCategories = [...categoryGroups.keys()].sort(
    (a, b) => (CATEGORY_ORDER[a] ?? 50) - (CATEGORY_ORDER[b] ?? 50),
  );

  const totalItems = Object.values(itemCollections).reduce(
    (sum, entries) => sum + entries.length,
    0,
  );
  const totalCollections = Object.keys(itemCollections).length;

  const wikiHref = entity.numericId
    ? `/wiki/${entity.numericId}`
    : getEntityHref(entityId);

  // Hero stat properties for this entity type
  const heroProps = HERO_STAT_PROPERTIES[entity.type] ?? [];

  // Separate generic collections (special ones rendered individually above)
  const genericCollections = Object.entries(itemCollections)
    .filter(([name]) => !SPECIAL_COLLECTIONS.has(name))
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <SidebarProvider>
      <WikiSidebar sections={getKBDataNav()} />
      <div className="flex-1 min-w-0">
        <div className="md:hidden px-4 pt-3">
          <MobileSidebarTrigger />
        </div>
        <div className="max-w-[65rem] mx-auto px-8 py-4">
          {/* ── Breadcrumbs ─────────────────────────────────────── */}
          <nav className="text-sm text-muted-foreground mb-4">
            <Link href="/wiki/E1019" className="hover:underline">
              KB Data
            </Link>
            <span className="mx-1.5">/</span>
            <span>{entity.name}</span>
          </nav>

          {/* ── Header ──────────────────────────────────────────── */}
          <div className="mb-6">
            <div className="flex items-baseline gap-3 mb-1">
              <h1 className="text-2xl font-bold">{entity.name}</h1>
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                {titleCase(entity.type)}
              </span>
            </div>
            {entity.aliases && entity.aliases.length > 0 && (
              <p className="text-sm text-muted-foreground mb-1">
                Also known as: {entity.aliases.join(", ")}
              </p>
            )}
            <div className="flex items-center gap-3 text-sm">
              <Link
                href={wikiHref}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                Wiki page &rarr;
              </Link>
              {verdicts.size > 0 && (
                <VerificationSummary verdicts={verdicts} totalFacts={structuredFacts.length} />
              )}
            </div>
          </div>

          {/* ── Hero Stat Cards ──────────────────────────────────── */}
          {heroProps.length > 0 && (
            <section className="mb-8">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
                {heroProps.map((propId) => (
                  <StatCard key={propId} entityId={entityId} propertyId={propId} />
                ))}
              </div>
            </section>
          )}

          {/* ── Key People (card grid) ───────────────────────────── */}
          {itemCollections["key-persons"] && itemCollections["key-persons"].length > 0 && (
            <section className="mb-8">
              <SectionHeader title="Key People" count={itemCollections["key-persons"].length} id="col-key-persons" />
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {itemCollections["key-persons"].map((item) => (
                  <PersonCard key={item.key} item={item} />
                ))}
              </div>
            </section>
          )}

          {/* ── Funding Rounds (timeline) ────────────────────────── */}
          {itemCollections["funding-rounds"] && itemCollections["funding-rounds"].length > 0 && (
            <section className="mb-8">
              <SectionHeader title="Funding History" count={itemCollections["funding-rounds"].length} id="col-funding-rounds" />
              <div className="border border-border rounded-lg px-4 bg-card">
                {[...itemCollections["funding-rounds"]]
                  .sort((a, b) => {
                    const dateA = a.fields.date ? String(a.fields.date) : "";
                    const dateB = b.fields.date ? String(b.fields.date) : "";
                    return dateB.localeCompare(dateA);
                  })
                  .map((item) => (
                    <FundingRoundRow key={item.key} item={item} />
                  ))}
              </div>
            </section>
          )}

          {/* ── Model Releases ────────────────────────────────────── */}
          {itemCollections["model-releases"] && itemCollections["model-releases"].length > 0 && (
            <section className="mb-8">
              <SectionHeader title="Model Releases" count={itemCollections["model-releases"].length} id="col-model-releases" />
              <div className="border border-border rounded-lg px-4 bg-card">
                {[...itemCollections["model-releases"]]
                  .sort((a, b) => {
                    const dateA = a.fields.released ? String(a.fields.released) : "";
                    const dateB = b.fields.released ? String(b.fields.released) : "";
                    return dateB.localeCompare(dateA);
                  })
                  .map((item) => (
                    <ModelReleaseRow key={item.key} item={item} />
                  ))}
              </div>
            </section>
          )}

          {/* ── Products (card grid) ──────────────────────────────── */}
          {itemCollections["products"] && itemCollections["products"].length > 0 && (
            <section className="mb-8">
              <SectionHeader title="Products" count={itemCollections["products"].length} id="col-products" />
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {itemCollections["products"].map((item) => (
                  <ProductCard key={item.key} item={item} />
                ))}
              </div>
            </section>
          )}

          {/* ── Facts by Category ─────────────────────────────────── */}
          {sortedCategories.length > 0 && (
            <div className="mb-8">
              <h2 className="text-lg font-semibold mb-4">All Facts</h2>
              {/* Category jump links */}
              <div className="flex flex-wrap gap-2 mb-4">
                {sortedCategories.map((cat) => (
                  <a
                    key={cat}
                    href={`#cat-${cat}`}
                    className="text-xs px-2 py-1 rounded-full border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {CATEGORY_LABELS[cat] ?? titleCase(cat)}
                    <span className="ml-1 opacity-50">
                      {categoryGroups.get(cat)?.length ?? 0}
                    </span>
                  </a>
                ))}
              </div>
              {sortedCategories.map((category) => {
                const propertyIds = categoryGroups.get(category);
                if (!propertyIds || propertyIds.length === 0) return null;
                return (
                  <CategoryFactSection
                    key={category}
                    category={category}
                    propertyIds={propertyIds}
                    factGroups={factGroups}
                    verdicts={verdicts}
                  />
                );
              })}
            </div>
          )}

          {/* ── Other Collections ──────────────────────────────────── */}
          {genericCollections.length > 0 && (
            <div className="mb-8">
              {genericCollections.map(([collectionName, items]) => (
                <GenericCollectionTable
                  key={collectionName}
                  collectionName={collectionName}
                  items={items}
                />
              ))}
            </div>
          )}

          {/* ── Internal Metadata (collapsed) ──────────────────────── */}
          <details className="mb-8 group">
            <summary className="flex items-center gap-2 text-xs text-muted-foreground/60 cursor-pointer hover:text-muted-foreground select-none py-2">
              <span className="group-open:rotate-90 transition-transform">&#9654;</span>
              Internal Metadata
            </summary>
            <div className="mt-2 border border-border/50 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <tbody className="divide-y divide-border/50">
                  <tr>
                    <td className="py-1.5 px-3 font-medium text-muted-foreground w-[8rem] bg-muted/20">ID</td>
                    <td className="py-1.5 px-3 font-mono">{entity.id}</td>
                  </tr>
                  {entity.stableId && (
                    <tr>
                      <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Stable ID</td>
                      <td className="py-1.5 px-3 font-mono">{entity.stableId}</td>
                    </tr>
                  )}
                  {entity.numericId && (
                    <tr>
                      <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Numeric ID</td>
                      <td className="py-1.5 px-3 font-mono">{entity.numericId}</td>
                    </tr>
                  )}
                  <tr>
                    <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Type</td>
                    <td className="py-1.5 px-3">{entity.type}</td>
                  </tr>
                  {entity.parent && (
                    <tr>
                      <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Parent</td>
                      <td className="py-1.5 px-3">
                        <Link href={`/kb/entity/${entity.parent}`} className="text-blue-600 hover:underline dark:text-blue-400">
                          {getKBEntity(entity.parent)?.name ?? entity.parent}
                        </Link>
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">YAML Source</td>
                    <td className="py-1.5 px-3 font-mono">packages/kb/data/things/{entityId}.yaml</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Facts</td>
                    <td className="py-1.5 px-3">
                      {structuredFacts.length} structured
                      {allFacts.length !== structuredFacts.length && ` (${allFacts.length} total)`}
                    </td>
                  </tr>
                  {totalItems > 0 && (
                    <tr>
                      <td className="py-1.5 px-3 font-medium text-muted-foreground bg-muted/20">Records</td>
                      <td className="py-1.5 px-3">
                        {totalItems} in {totalCollections} collection{totalCollections !== 1 ? "s" : ""}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </div>
    </SidebarProvider>
  );
}
