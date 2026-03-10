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
} from "@/data/kb";
import { getEntityHref } from "@/data";
import type { Fact, Property } from "@longterm-wiki/kb";
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

/** Fetch all verdicts for an entity from wiki-server. Returns empty map on failure. */
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

/** Build a summary of verdict counts from the map. */
function verdictSummary(verdicts: Map<string, VerdictRow>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of verdicts.values()) {
    counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
  }
  return counts;
}

// ─── Static params ───────────────────────────────────────────────────

export function generateStaticParams() {
  // Include ALL entities, even description-only ones
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

// ─── Helpers ─────────────────────────────────────────────────────────

/** Group facts by propertyId, excluding "description". */
function groupFactsByProperty(facts: Fact[]): Map<string, Fact[]> {
  const groups = new Map<string, Fact[]>();
  for (const fact of facts) {
    if (fact.propertyId === "description") continue;
    const list = groups.get(fact.propertyId) ?? [];
    list.push(fact);
    groups.set(fact.propertyId, list);
  }
  // Sort facts within each group by asOf descending (already sorted from getKBFacts, but ensure)
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

/** Render a source cell for a fact. */
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

/** Render a fact value, with special handling for ref/refs types. */
function FactValueDisplay({
  fact,
  property,
}: {
  fact: Fact;
  property?: Property;
}) {
  const v = fact.value;

  // Ref type: link to the referenced entity
  if (v.type === "ref") {
    const refEntity = getKBEntity(v.value);
    return (
      <Link
        href={`/kb/entity/${v.value}`}
        className="text-blue-600 hover:underline dark:text-blue-400"
      >
        {refEntity?.name ?? v.value}
      </Link>
    );
  }

  // Refs type: list of links
  if (v.type === "refs") {
    return (
      <span>
        {v.value.map((refId, i) => {
          const refEntity = getKBEntity(refId);
          return (
            <span key={`${refId}-${i}`}>
              {i > 0 && ", "}
              <Link
                href={`/kb/entity/${refId}`}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                {refEntity?.name ?? refId}
              </Link>
            </span>
          );
        })}
      </span>
    );
  }

  // Everything else: use the standard formatter
  return (
    <span>
      {formatKBFactValue(fact, property?.unit, property?.display)}
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
  const recordCollections = getKBAllRecordCollections(entityId);
  const verdicts = await fetchEntityVerdicts(entityId);

  // Sort property groups alphabetically by property name
  const sortedPropertyIds = [...factGroups.keys()].sort((a, b) => {
    const pA = getKBProperty(a);
    const pB = getKBProperty(b);
    return (pA?.name ?? a).localeCompare(pB?.name ?? b);
  });

  const totalRecords = Object.values(recordCollections).reduce(
    (sum, entries) => sum + entries.length,
    0,
  );
  const totalCollections = Object.keys(recordCollections).length;

  const wikiHref = entity.numericId
    ? `/wiki/${entity.numericId}`
    : getEntityHref(entityId);

  return (
    <SidebarProvider>
      <WikiSidebar sections={getKBDataNav()} />
      <div className="flex-1 min-w-0">
        <div className="md:hidden px-4 pt-3">
          <MobileSidebarTrigger />
        </div>
        <div className="max-w-[65rem] mx-auto px-4 md:px-8 py-4">
          {/* ── Breadcrumbs ─────────────────────────────────────── */}
          <nav className="text-sm text-muted-foreground mb-4">
            <Link href="/wiki/E1019" className="hover:underline hover:text-foreground">
              KB Data
            </Link>
            <span className="mx-1.5 text-muted-foreground/50">/</span>
            <span className="text-foreground">{entity.name}</span>
          </nav>

          {/* ── Header ──────────────────────────────────────────── */}
          <h1 className="text-2xl font-bold mb-1">{entity.name}</h1>
          <p className="text-xs text-muted-foreground/60 mb-1 font-mono">
            {entity.id}
            {entity.stableId && <> &middot; {entity.stableId}</>}
            {entity.numericId && <> &middot; {entity.numericId}</>}
            {" "}&middot; {entity.type}
          </p>
          <p className="text-sm mb-1">
            <Link
              href={wikiHref}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              &rarr; Wiki page
            </Link>
          </p>
          <p className="text-xs text-muted-foreground/50 mb-6 font-mono">
            Source: packages/kb/data/things/{entityId}.yaml
          </p>

          {/* ── Thing Metadata ──────────────────────────────────── */}
          <details className="mb-6 group/meta">
            <summary className="text-sm font-medium text-muted-foreground mb-2 cursor-pointer hover:text-foreground select-none flex items-center gap-1.5">
              <span className="text-xs group-open/meta:rotate-90 transition-transform">&#9654;</span>
              Thing Metadata
            </summary>
            <div className="border border-border rounded-lg overflow-hidden overflow-x-auto">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-border">
                  <MetaRow label="ID" value={entity.id} />
                  <MetaRow label="Stable ID" value={entity.stableId} />
                  {entity.numericId && (
                    <MetaRow label="Numeric ID" value={entity.numericId} />
                  )}
                  <MetaRow label="Type" value={entity.type} />
                  <MetaRow label="Name" value={entity.name} />
                  {entity.aliases && entity.aliases.length > 0 && (
                    <MetaRow
                      label="Aliases"
                      value={entity.aliases.join(", ")}
                    />
                  )}
                  {entity.parent && (
                    <tr>
                      <td className="py-2 px-4 font-medium text-muted-foreground w-[7rem] md:w-[10rem] text-sm bg-card whitespace-nowrap">
                        Parent
                      </td>
                      <td className="py-2 px-4 text-sm bg-card">
                        <Link
                          href={`/kb/entity/${entity.parent}`}
                          className="text-blue-600 hover:underline dark:text-blue-400"
                        >
                          {getKBEntity(entity.parent)?.name ?? entity.parent}
                        </Link>
                      </td>
                    </tr>
                  )}
                  <MetaRow
                    label="YAML File"
                    value={`packages/kb/data/things/${entityId}.yaml`}
                  />
                  <MetaRow
                    label="Total Facts"
                    value={`${structuredFacts.length} structured facts${allFacts.length !== structuredFacts.length ? ` (${allFacts.length} total incl. description)` : ""}`}
                  />
                  {totalRecords > 0 && (
                    <MetaRow
                      label="Total Records"
                      value={`${totalRecords} records in ${totalCollections} collection${totalCollections !== 1 ? "s" : ""}`}
                    />
                  )}
                  {verdicts.size > 0 && (
                    <tr>
                      <td className="py-2 px-4 font-medium text-muted-foreground w-[10rem] text-sm bg-card">
                        Verification
                      </td>
                      <td className="py-2 px-4 text-sm bg-card">
                        <VerificationSummary verdicts={verdicts} totalFacts={structuredFacts.length} />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </details>

          {/* ── Facts by Property ───────────────────────────────── */}
          {sortedPropertyIds.length > 0 && (
            <section className="mb-8">
              <h2 className="text-xl font-semibold mb-3 pb-2 border-b border-border">Facts by Property</h2>
              <div className="border border-border rounded-lg overflow-hidden overflow-x-auto divide-y divide-border">
                {sortedPropertyIds.map((propertyId) => {
                  const facts = factGroups.get(propertyId)!;
                  const property = getKBProperty(propertyId);
                  const latestFact = facts[0];

                  return (
                    <details key={propertyId} id={propertyId} className="group scroll-mt-16">
                      <summary className="flex items-center gap-3 md:gap-4 px-4 py-2.5 cursor-pointer hover:bg-muted/50 text-sm select-none">
                        <span className="font-medium shrink-0 w-[8rem] md:w-[11rem]">
                          {property?.name ?? propertyId}
                        </span>
                        <span className="text-muted-foreground truncate min-w-0 flex-1 hidden md:inline">
                          <FactValueDisplay fact={latestFact} property={property} />
                        </span>
                        <span className="text-muted-foreground text-xs whitespace-nowrap ml-auto">
                          {latestFact.asOf ? formatKBDate(latestFact.asOf) : ""}
                        </span>
                        <span className="text-muted-foreground text-xs whitespace-nowrap">
                          {facts.length} fact{facts.length !== 1 ? "s" : ""}
                        </span>
                        <span className="text-muted-foreground group-open:rotate-90 transition-transform">
                          &#9654;
                        </span>
                      </summary>

                      <div className="px-4 pb-3 pt-1 bg-muted/20 border-l-2 border-l-blue-200 dark:border-l-blue-800">
                        <div className="mb-2">
                          <Link
                            href={`/kb/property/${propertyId}`}
                            className="text-blue-600 hover:underline dark:text-blue-400 text-sm"
                          >
                            {property?.name ?? propertyId} &rarr;
                          </Link>
                        </div>
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-xs text-muted-foreground border-b border-border">
                              <th className="text-left py-1 pr-3 font-medium">
                                As Of
                              </th>
                              <th className="text-left py-1 pr-3 font-medium">
                                Value
                              </th>
                              <th className="text-left py-1 pr-3 font-medium">
                                Source
                              </th>
                              {verdicts.size > 0 && (
                                <th className="text-left py-1 pr-3 font-medium">
                                  Verified
                                </th>
                              )}
                              <th className="text-left py-1 font-medium">
                                Fact ID
                              </th>
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
                                    <FactValueDisplay
                                      fact={fact}
                                      property={property}
                                    />
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
          )}

          {/* ── Record Collections ─────────────────────────────────── */}
          {totalCollections > 0 && (
            <section className="mb-8">
              <h2 className="text-lg font-semibold mb-3 pb-2 border-b border-border">Record Collections</h2>
              <div className="space-y-4">
                {Object.entries(recordCollections)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([collectionName, items]) => {
                    const recordSchema = items[0] ? getKBRecordSchema(items[0].schema) : undefined;
                    const fieldDefs = recordSchema?.fields;

                    // Determine column order: schema fields first, then any extra fields from data
                    const schemaFieldNames = fieldDefs
                      ? Object.keys(fieldDefs)
                      : [];
                    const allFieldNames = new Set<string>();
                    for (const item of items) {
                      for (const key of Object.keys(item.fields)) {
                        allFieldNames.add(key);
                      }
                    }
                    const allColumns = schemaFieldNames.length > 0
                      ? [
                          ...schemaFieldNames,
                          ...[...allFieldNames].filter(
                            (f) => !schemaFieldNames.includes(f),
                          ),
                        ]
                      : [...allFieldNames];
                    // Remove "name" from data columns — it's shown in the link column
                    const columns = allColumns.filter((col) => col !== "name");

                    return (
                      <details key={collectionName} id={`records-${collectionName}`} className="group scroll-mt-16">
                        <summary className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-muted/50 text-sm select-none border border-border rounded-lg">
                          <span className="font-medium">
                            {titleCase(collectionName)}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {items.length} record
                            {items.length !== 1 ? "s" : ""}
                          </span>
                          <span className="ml-auto text-muted-foreground group-open:rotate-90 transition-transform">
                            &#9654;
                          </span>
                        </summary>

                        <div className="mt-1 border border-border rounded-lg overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                                <th className="text-left py-1.5 px-3 font-medium">
                                  Name
                                </th>
                                {columns.map((col) => (
                                  <th
                                    key={col}
                                    className={`text-left py-1.5 px-3 font-medium${col === "notes" ? " min-w-[10rem] max-w-[14rem]" : ""}`}
                                  >
                                    {titleCase(col.replace(/([a-z])([A-Z])/g, "$1 $2"))}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border/50">
                              {items.map((item) => (
                                <tr key={item.key}>
                                  <td className="py-1.5 px-3 text-sm">
                                    <Link
                                      href={`/kb/record/${item.key}`}
                                      className="text-blue-600 hover:underline dark:text-blue-400"
                                    >
                                      {typeof item.fields.name === "string" ? item.fields.name : titleCase(item.key)}
                                    </Link>
                                  </td>
                                  {columns.map((col) => {
                                    const cellValue = item.fields[col];
                                    const fieldDef = fieldDefs?.[col];

                                    // Special rendering for ref fields
                                    if (
                                      fieldDef?.type === "ref" &&
                                      typeof cellValue === "string"
                                    ) {
                                      const refEntity =
                                        getKBEntity(cellValue);
                                      return (
                                        <td
                                          key={col}
                                          className="py-1.5 px-3"
                                        >
                                          <Link
                                            href={`/kb/entity/${cellValue}`}
                                            className="text-blue-600 hover:underline dark:text-blue-400"
                                          >
                                            {refEntity?.name ?? cellValue}
                                          </Link>
                                        </td>
                                      );
                                    }

                                    // URL rendering
                                    if (
                                      typeof cellValue === "string" &&
                                      isUrl(cellValue)
                                    ) {
                                      return (
                                        <td
                                          key={col}
                                          className="py-1.5 px-3"
                                        >
                                          <a
                                            href={cellValue}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-blue-600 hover:underline dark:text-blue-400"
                                          >
                                            {shortDomain(cellValue)}
                                          </a>
                                        </td>
                                      );
                                    }

                                    return (
                                      <td
                                        key={col}
                                        className={`py-1.5 px-3${col === "notes" ? " max-w-[14rem] text-xs text-muted-foreground" : ""}`}
                                      >
                                        {formatKBCellValue(
                                          cellValue,
                                          fieldDef,
                                        )}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    );
                  })}
              </div>
            </section>
          )}
        </div>
      </div>
    </SidebarProvider>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td className="py-2 px-4 font-medium text-muted-foreground w-[7rem] md:w-[10rem] text-sm bg-card whitespace-nowrap">
        {label}
      </td>
      <td className="py-2 px-4 text-sm bg-card">
        <code className="text-xs">{value}</code>
      </td>
    </tr>
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
