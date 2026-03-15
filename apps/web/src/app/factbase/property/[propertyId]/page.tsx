import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { WikiSidebar, MobileSidebarTrigger } from "@/components/wiki/WikiSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { getKBDataNav } from "@/lib/wiki-nav";
import {
  getKBEntities,
  getKBEntity,
  getKBProperty,
  getKBAllFactsByProperty,
} from "@/data/factbase";
import type { Fact } from "@longterm-wiki/factbase";
import {
  formatKBFactValue,
  formatKBDate,
  shortDomain,
  isUrl,
} from "@/components/wiki/factbase/format";
import { KVRow, KVTable, Dash } from "@/components/wiki/factbase/factbase-detail-shared";

// ── Rendering mode ───────────────────────────────────────────────────
// Render on-demand to reduce build output size.
// These are internal KB property pages with low traffic.

// ── Metadata ─────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ propertyId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { propertyId } = await params;
  const property = getKBProperty(propertyId);
  return {
    title: property ? `Property: ${property.name}` : `Property: ${propertyId}`,
    robots: { index: false },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

// ── Page ─────────────────────────────────────────────────────────────

export default async function PropertyDetailPage({ params }: PageProps) {
  const { propertyId } = await params;
  const property = getKBProperty(propertyId);
  if (!property) notFound();

  // All facts (including expired) for the history table
  const allFactsByEntity = getKBAllFactsByProperty(propertyId, undefined, {
    includeExpired: true,
  });
  // Current (non-expired) facts for coverage calculation
  const currentFactsByEntity = getKBAllFactsByProperty(propertyId);

  // Compute totals from all-time data
  let totalFacts = 0;
  for (const facts of allFactsByEntity.values()) {
    totalFacts += facts.length;
  }
  const allTimeEntityCount = allFactsByEntity.size;

  // Compute coverage from current (non-expired) facts
  const allEntities = getKBEntities();
  const applicableEntities = property.appliesTo
    ? allEntities.filter((e) => property.appliesTo!.includes(e.type))
    : allEntities;
  const coveredEntityCount = currentFactsByEntity.size;
  const coverage =
    applicableEntities.length > 0
      ? Math.round((coveredEntityCount / applicableEntities.length) * 100)
      : 0;
  const missingEntities = applicableEntities.filter(
    (e) => !currentFactsByEntity.has(e.id),
  );

  // Sort entities by latest fact value (descending for numbers, alpha for text)
  const sortedEntities = [...allFactsByEntity.entries()].sort((a, b) => {
    // Sort by fact count descending
    return b[1].length - a[1].length;
  });

  const content = (
    <div>
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4">
        <Link href="/wiki/E1019" className="text-primary hover:underline">
          KB Data
        </Link>
        <span>/</span>
        <Link href="/wiki/E1021" className="text-primary hover:underline">
          Properties
        </Link>
        <span>/</span>
        <span>{property.name}</span>
      </nav>

      {/* Header */}
      <h1 className="text-2xl font-bold mb-1">{property.name}</h1>
      <p className="text-sm text-muted-foreground mb-6">
        <code className="text-xs">{propertyId}</code>
        {" \u00B7 "}
        {totalFacts} fact{totalFacts !== 1 ? "s" : ""} across {allTimeEntityCount}{" "}
        entit{allTimeEntityCount !== 1 ? "ies" : "y"}
        {property.category && (
          <>
            {" \u00B7 "}
            <span className="capitalize">{property.category}</span>
          </>
        )}
      </p>

      {/* Definition */}
      <h2 className="text-base font-semibold mt-6 mb-2">Definition</h2>
      <KVTable>
        <KVRow label="Name">{property.name}</KVRow>
        <KVRow label="Description">
          {property.description ?? <Dash />}
        </KVRow>
        <KVRow label="Data Type">
          <code className="text-xs">{property.dataType}</code>
        </KVRow>
        <KVRow label="Unit">
          {property.unit ? (
            <code className="text-xs">{property.unit}</code>
          ) : (
            <Dash />
          )}
        </KVRow>
        <KVRow label="Category">
          {property.category ? (
            <span className="capitalize">{property.category}</span>
          ) : (
            <Dash />
          )}
        </KVRow>
        <KVRow label="Temporal">{property.temporal ? "Yes" : "No"}</KVRow>
        <KVRow label="Computed">{property.computed ? "Yes" : "No"}</KVRow>
        <KVRow label="Applies To">
          {property.appliesTo ? property.appliesTo.join(", ") : "any"}
        </KVRow>
        {property.inverseId && (
          <KVRow label="Inverse">
            <Link
              href={`/factbase/property/${property.inverseId}`}
              className="text-primary hover:underline"
            >
              {property.inverseName ?? property.inverseId}
            </Link>
            {" "}
            <code className="text-xs text-muted-foreground">
              ({property.inverseId})
            </code>
          </KVRow>
        )}
        {property.display && (
          <KVRow label="Display Format">
            <code className="text-xs">
              {JSON.stringify(property.display)}
            </code>
          </KVRow>
        )}
      </KVTable>

      {/* All Facts */}
      {sortedEntities.length > 0 && (
        <>
          <h2 className="text-base font-semibold mt-6 mb-2">
            All Facts ({totalFacts})
          </h2>
          <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
            {sortedEntities.map(([entityId, facts]) => {
              const entity = getKBEntity(entityId);
              const entityName = entity?.name ?? entityId;
              const latestFact = facts[0];

              return (
                <details key={entityId} className="group">
                  <summary className="flex items-center gap-4 px-4 py-2.5 cursor-pointer hover:bg-muted/50 text-sm select-none">
                    <span className="font-medium min-w-[12rem]">
                      {entityName}
                    </span>
                    <span className="flex-1 text-muted-foreground truncate font-mono">
                      {formatKBFactValue(
                        latestFact,
                        property.unit,
                        property.display,
                      )}
                    </span>
                    <span className="text-muted-foreground text-xs whitespace-nowrap">
                      {formatKBDate(latestFact.asOf)}
                    </span>
                    <span className="text-muted-foreground text-xs whitespace-nowrap">
                      {facts.length} value{facts.length !== 1 ? "s" : ""}
                    </span>
                    <span className="text-muted-foreground text-xs group-open:rotate-90 transition-transform">
                      &#9654;
                    </span>
                  </summary>
                  <div className="px-4 pb-3 pt-1 bg-muted/20">
                    <div className="mb-2">
                      <Link
                        href={`/factbase/entity/${entityId}`}
                        className="text-blue-600 hover:underline dark:text-blue-400 text-sm"
                      >
                        {entityName} &rarr;
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
                        {facts.map((fact: Fact) => (
                          <tr key={fact.id}>
                            <td className="py-1.5 pr-3 text-muted-foreground whitespace-nowrap">
                              {formatKBDate(fact.asOf)}
                            </td>
                            <td className="py-1.5 pr-3 font-mono">
                              {formatKBFactValue(
                                fact,
                                property.unit,
                                property.display,
                              )}
                            </td>
                            <td className="py-1.5 pr-3">
                              {fact.source && isUrl(fact.source) ? (
                                <a
                                  href={fact.source}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:underline dark:text-blue-400"
                                >
                                  {shortDomain(fact.source)}
                                </a>
                              ) : fact.source ? (
                                <span className="text-xs text-muted-foreground">
                                  {fact.source}
                                </span>
                              ) : (
                                <Dash />
                              )}
                            </td>
                            <td className="py-1.5">
                              <Link
                                href={`/factbase/fact/${fact.id}`}
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
        </>
      )}

      {/* Coverage */}
      {property.appliesTo && property.appliesTo.length > 0 && (
        <>
          <h2 className="text-base font-semibold mt-6 mb-2">Coverage</h2>
          <KVTable>
            <KVRow label="Applies To">
              {property.appliesTo.join(", ")}
            </KVRow>
            <KVRow label="Applicable Entities">
              {applicableEntities.length}
            </KVRow>
            <KVRow label="Have Current Data">
              {coveredEntityCount} of {applicableEntities.length} ({coverage}%)
            </KVRow>
          </KVTable>

          {missingEntities.length > 0 && (
            <div className="mt-3">
              <h3 className="text-sm font-medium text-muted-foreground mb-2">
                Missing ({missingEntities.length})
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {missingEntities
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((e) => (
                    <Link
                      key={e.id}
                      href={`/factbase/entity/${e.id}`}
                      className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:text-primary hover:bg-muted/80"
                    >
                      {e.name}
                    </Link>
                  ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    <SidebarProvider>
      <WikiSidebar sections={getKBDataNav()} />
      <div className="flex-1 min-w-0">
        <div className="md:hidden px-4 pt-3">
          <MobileSidebarTrigger />
        </div>
        <div className="max-w-[65rem] mx-auto px-8 py-4">{content}</div>
      </div>
    </SidebarProvider>
  );
}
