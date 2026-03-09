import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";

import {
  getKBEntities,
  getKBEntity,
  getKBFacts,
  getKBAllItemCollections,
  getKBProperty,
  getKBSchema,
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
  if (fact.sourceResource) {
    return (
      <span className="text-muted-foreground text-xs">R: {fact.sourceResource}</span>
    );
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
            <span key={refId}>
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
  const itemCollections = getKBAllItemCollections(entityId);
  const schema = getKBSchema(entity.type);

  // Sort property groups alphabetically by property name
  const sortedPropertyIds = [...factGroups.keys()].sort((a, b) => {
    const pA = getKBProperty(a);
    const pB = getKBProperty(b);
    return (pA?.name ?? a).localeCompare(pB?.name ?? b);
  });

  const totalItems = Object.values(itemCollections).reduce(
    (sum, entries) => sum + entries.length,
    0,
  );
  const totalCollections = Object.keys(itemCollections).length;

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
          <h1 className="text-2xl font-bold mb-1">{entity.name}</h1>
          <p className="text-sm text-muted-foreground mb-1">
            <code className="text-xs">{entity.id}</code>
            {entity.stableId && (
              <>
                {" "}
                &middot;{" "}
                <code className="text-xs">{entity.stableId}</code>
              </>
            )}
            {entity.numericId && (
              <>
                {" "}
                &middot;{" "}
                <code className="text-xs">{entity.numericId}</code>
              </>
            )}
            {" "}
            &middot; <span>{entity.type}</span>
          </p>
          <p className="text-sm mb-1">
            <Link
              href={wikiHref}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              &rarr; Wiki page: {wikiHref}
            </Link>
          </p>
          <p className="text-xs text-muted-foreground mb-6">
            Source:{" "}
            <code>packages/kb/data/things/{entityId}.yaml</code>
          </p>

          {/* ── Thing Metadata ──────────────────────────────────── */}
          <section className="mb-8">
            <h2 className="text-lg font-semibold mb-3">Thing Metadata</h2>
            <div className="border border-border rounded-lg overflow-hidden">
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
                      <td className="py-2 px-4 font-medium text-muted-foreground w-[10rem] text-sm bg-card">
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
                  {totalItems > 0 && (
                    <MetaRow
                      label="Total Items"
                      value={`${totalItems} items in ${totalCollections} collection${totalCollections !== 1 ? "s" : ""}`}
                    />
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── Facts by Property ───────────────────────────────── */}
          {sortedPropertyIds.length > 0 && (
            <section className="mb-8">
              <h2 className="text-lg font-semibold mb-3">Facts by Property</h2>
              <div className="border border-border rounded-lg overflow-hidden overflow-x-auto divide-y divide-border">
                {sortedPropertyIds.map((propertyId) => {
                  const facts = factGroups.get(propertyId)!;
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
                        <span className="text-muted-foreground text-xs whitespace-nowrap">
                          {facts.length} fact{facts.length !== 1 ? "s" : ""}
                        </span>
                        <span className="text-muted-foreground text-xs group-open:rotate-90 transition-transform">
                          &#9654;
                        </span>
                      </summary>

                      <div className="px-4 pb-3 pt-1 bg-muted/20">
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
                              <th className="text-left py-1 font-medium">
                                Fact ID
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/50">
                            {facts.map((fact) => (
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
                                <td className="py-1.5">
                                  <Link
                                    href={`/kb/fact/${fact.id}`}
                                    className="text-blue-600 hover:underline dark:text-blue-400 font-mono text-xs"
                                  >
                                    {fact.id}
                                  </Link>
                                </td>
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

          {/* ── Item Collections ─────────────────────────────────── */}
          {totalCollections > 0 && (
            <section className="mb-8">
              <h2 className="text-lg font-semibold mb-3">Item Collections</h2>
              <div className="space-y-4">
                {Object.entries(itemCollections)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([collectionName, items]) => {
                    const collectionSchema =
                      schema?.items?.[collectionName];
                    const fieldDefs = collectionSchema?.fields;

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
                    const columns = schemaFieldNames.length > 0
                      ? [
                          ...schemaFieldNames,
                          ...[...allFieldNames].filter(
                            (f) => !schemaFieldNames.includes(f),
                          ),
                        ]
                      : [...allFieldNames];

                    return (
                      <details key={collectionName} id={`items-${collectionName}`} className="group scroll-mt-16">
                        <summary className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-muted/50 text-sm select-none border border-border rounded-lg">
                          <span className="font-medium">
                            {titleCase(collectionName)}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {items.length} item
                            {items.length !== 1 ? "s" : ""}
                          </span>
                          <span className="ml-auto text-muted-foreground text-xs group-open:rotate-90 transition-transform">
                            &#9654;
                          </span>
                        </summary>

                        <div className="mt-1 border border-border rounded-lg overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                                <th className="text-left py-1.5 px-3 font-medium">
                                  Key
                                </th>
                                {columns.map((col) => (
                                  <th
                                    key={col}
                                    className="text-left py-1.5 px-3 font-medium"
                                  >
                                    {titleCase(col)}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border/50">
                              {items.map((item) => (
                                <tr key={item.key}>
                                  <td className="py-1.5 px-3 font-mono text-xs">
                                    <Link
                                      href={`/kb/item/${item.key}`}
                                      className="text-blue-600 hover:underline dark:text-blue-400"
                                    >
                                      {item.key}
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
                                        className="py-1.5 px-3"
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
      <td className="py-2 px-4 font-medium text-muted-foreground w-[10rem] text-sm bg-card">
        {label}
      </td>
      <td className="py-2 px-4 text-sm bg-card">
        <code className="text-xs">{value}</code>
      </td>
    </tr>
  );
}
