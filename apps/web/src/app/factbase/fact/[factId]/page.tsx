import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import {
  getKBEntity,
  getKBFacts,
  getKBFactById,
  getKBProperty,
  isFactExpired,
} from "@/data/factbase";
import { getEntityHref } from "@/data";
import { getResourceIdForFact } from "@/data/resource-fact-links";
import type { Fact, Property } from "@longterm-wiki/factbase";
import { formatKBFactValue, formatKBDate, shortDomain, isUrl } from "@/components/wiki/factbase/format";
import { KVRow, KVTable, Dash } from "@/components/wiki/factbase/factbase-detail-shared";
import { FactSourcingDot } from "@/components/sourcing/FactSourcingDot";

// ── Rendering mode ───────────────────────────────────────────────────
// Render on-demand to reduce build output size (~492 pages saved).
// These are internal KB fact detail pages with low traffic.
// Cache for 1 hour to avoid expensive re-renders from bot crawlers.
export const revalidate = 3600;

// ── Metadata ─────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ factId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { factId } = await params;
  return {
    title: `Fact: ${factId}`,
    robots: { index: false },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h2 className="text-base font-semibold mt-6 mb-2">{children}</h2>;
}

function FactLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-primary hover:underline">
      {children}
    </Link>
  );
}

function getRawValue(fact: Fact): string {
  const v = fact.value;
  switch (v.type) {
    case "number":
      return String(v.value);
    case "text":
      return v.value;
    case "date":
      return v.value;
    case "boolean":
      return String(v.value);
    case "ref":
      return v.value;
    case "refs":
      return v.value.join(", ");
    case "range":
      return `${v.low}\u2013${v.high}`;
    case "min":
      return `>=${v.value}`;
    case "json":
      return JSON.stringify(v.value);
    default:
      return String((v as { value: unknown }).value);
  }
}

/** Render a single ref entity ID as a resolved name link. */
function RefLink({ entityId }: { entityId: string }) {
  const refEntity = getKBEntity(entityId);
  return (
    <Link
      href={`/factbase/entity/${entityId}`}
      className="text-primary hover:underline"
    >
      {refEntity?.name ?? entityId}
    </Link>
  );
}

/**
 * Render a fact value with entity resolution for ref/refs types.
 * For ref-type values, resolves the entity ID to a human-readable name
 * and renders it as a clickable link. For other types, returns the
 * formatted string value.
 */
function FactValueDisplay({
  fact,
  unit,
  display,
}: {
  fact: Fact;
  unit?: string;
  display?: Property["display"];
}) {
  const v = fact.value;

  if (v.type === "ref") {
    return <RefLink entityId={v.value} />;
  }

  if (v.type === "refs") {
    return (
      <>
        {v.value.map((refId: string, i: number) => (
          <span key={refId}>
            {i > 0 && ", "}
            <RefLink entityId={refId} />
          </span>
        ))}
      </>
    );
  }

  return <>{formatKBFactValue(fact, unit, display)}</>;
}

function getValueType(fact: Fact): string {
  return fact.value.type;
}

function getUnit(fact: Fact, property?: Property): string | undefined {
  if (fact.value.type === "number" && fact.value.unit) return fact.value.unit;
  if (fact.value.type === "range" && fact.value.unit) return fact.value.unit;
  if (fact.value.type === "min" && fact.value.unit) return fact.value.unit;
  return property?.unit;
}

// ── Page ─────────────────────────────────────────────────────────────

export default async function FactDetailPage({ params }: PageProps) {
  const { factId } = await params;
  const fact = getKBFactById(factId);
  if (!fact) notFound();

  const entity = getKBEntity(fact.subjectId);
  const property = getKBProperty(fact.propertyId);
  const entityName = entity?.name ?? fact.subjectId;
  const propertyName = property?.name ?? fact.propertyId;

  const rawValue = getRawValue(fact);
  const valueType = getValueType(fact);
  const unit = getUnit(fact, property);

  const expired = isFactExpired(fact);

  // Time series: all facts for same entity+property
  const timeSeriesFacts = getKBFacts(fact.subjectId, fact.propertyId).filter(
    (f) => f.propertyId !== "description"
  );

  const hasCurrencyData = !!(
    fact.currency ||
    fact.usdEquivalent ||
    fact.exchangeRate ||
    fact.exchangeRateDate ||
    fact.dollarYear
  );

  // Check if this fact's source URL matches a tracked resource
  const trackedResourceId = getResourceIdForFact(factId);

  const entityHref = entity?.wikiId
    ? `/wiki/${entity.wikiId}`
    : getEntityHref(fact.subjectId);

  const content = (
    <div>
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4">
        <FactLink href="/factbase">FactBase</FactLink>
        <span>/</span>
        <FactLink href={`/factbase/entity/${fact.subjectId}`}>{entityName}</FactLink>
        <span>/</span>
        <span>{propertyName}</span>
        <span>/</span>
        <span className="font-mono text-xs">{factId}</span>
      </nav>

      {/* Header */}
      <h1 className="text-2xl font-bold mb-1 flex items-center gap-2">
        <FactValueDisplay fact={fact} unit={property?.unit} display={property?.display} />
        <FactSourcingDot factId={factId} sourceUrl={fact.source} size="md" />
      </h1>
      <p className="text-sm text-muted-foreground mb-6">
        <FactLink href={`/factbase/entity/${fact.subjectId}`}>{entityName}</FactLink>
        {" \u203A "}
        <span>{propertyName}</span>
      </p>

      {/* Core Data */}
      <SectionHeader>Core Data</SectionHeader>
      <KVTable>
        <KVRow label="Entity">
          <FactLink href={`/factbase/entity/${fact.subjectId}`}>{entityName}</FactLink>
        </KVRow>
        <KVRow label="Property">
          <FactLink href={`/factbase/property/${fact.propertyId}`}>{propertyName}</FactLink>
        </KVRow>
        <KVRow label="Formatted Value">
          <FactValueDisplay fact={fact} unit={property?.unit} display={property?.display} />
        </KVRow>
        <KVRow label="Raw Value">
          <span className="font-mono">{rawValue}</span>
        </KVRow>
        <KVRow label="Value Type">
          <span className="font-mono">{valueType}</span>
        </KVRow>
        <KVRow label="Unit">
          {unit ? <span className="font-mono">{unit}</span> : <Dash />}
        </KVRow>
        <KVRow label="As Of">{formatKBDate(fact.asOf)}</KVRow>
        <KVRow label="Valid End">{fact.validEnd ? formatKBDate(fact.validEnd) : <Dash />}</KVRow>
        <KVRow label="Expired?">
          {expired ? (
            <span className="text-destructive font-medium">Yes</span>
          ) : (
            <span className="text-green-600 dark:text-green-400">No</span>
          )}
        </KVRow>
      </KVTable>

      {/* Source */}
      <SectionHeader>Source</SectionHeader>
      <KVTable>
        <KVRow label="Source URL">
          {fact.source && isUrl(fact.source) ? (
            <span className="flex flex-col gap-1">
              <a
                href={fact.source}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline font-mono text-xs break-all"
              >
                {shortDomain(fact.source)}
                <span className="text-muted-foreground ml-1">{"\u2197"}</span>
              </a>
              {trackedResourceId && (
                <Link
                  href={`/resources/${trackedResourceId}`}
                  className="text-primary hover:underline text-xs"
                >
                  View tracked resource {"\u2192"}
                </Link>
              )}
            </span>
          ) : fact.source ? (
            <span className="font-mono text-xs break-all">{fact.source}</span>
          ) : (
            <Dash />
          )}
        </KVRow>
        <KVRow label="Source Quote">
          {fact.sourceQuote ? (
            <span className="italic text-muted-foreground">{"\u201C"}{fact.sourceQuote}{"\u201D"}</span>
          ) : (
            <Dash />
          )}
        </KVRow>
        <KVRow label="Notes">{fact.notes ?? <Dash />}</KVRow>
        <KVRow label="Source Check">
          <span className="inline-flex items-center gap-2">
            <FactSourcingDot factId={factId} sourceUrl={fact.source} size="md" />
            <FactLink href={`/sourcing/fact/${factId}`}>
              view source checks {"\u2192"}
            </FactLink>
          </span>
        </KVRow>
      </KVTable>

      {/* Currency / Conversion */}
      {hasCurrencyData && (
        <>
          <SectionHeader>Currency / Conversion</SectionHeader>
          <KVTable>
            <KVRow label="Currency">
              {fact.currency ? <span className="font-mono">{fact.currency}</span> : <Dash />}
            </KVRow>
            <KVRow label="USD Equivalent">
              {fact.usdEquivalent != null ? (
                <span className="font-mono">{fact.usdEquivalent.toLocaleString()}</span>
              ) : (
                <Dash />
              )}
            </KVRow>
            <KVRow label="Exchange Rate">
              {fact.exchangeRate != null ? (
                <span className="font-mono">{fact.exchangeRate}</span>
              ) : (
                <Dash />
              )}
            </KVRow>
            <KVRow label="Exchange Rate Date">
              {fact.exchangeRateDate
                ? formatKBDate(fact.exchangeRateDate)
                : <Dash />}
            </KVRow>
            <KVRow label="Dollar Year">
              {fact.dollarYear != null ? (
                <span className="font-mono">{fact.dollarYear}</span>
              ) : (
                <Dash />
              )}
            </KVRow>
          </KVTable>
        </>
      )}

      {/* Time Series */}
      {timeSeriesFacts.length > 1 && (
        <>
          <SectionHeader>
            Time Series ({timeSeriesFacts.length} facts)
          </SectionHeader>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">As Of</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Fact ID</th>
                  <th className="px-3 py-2 font-medium w-5"></th>
                </tr>
              </thead>
              <tbody>
                {timeSeriesFacts.map((f) => {
                  const isCurrent = f.id === factId;
                  return (
                    <tr
                      key={f.id}
                      className={`border-t border-border ${isCurrent ? "bg-primary/5" : "[&:nth-child(even)]:bg-muted/30"}`}
                    >
                      <td className="px-3 py-1.5">{formatKBDate(f.asOf)}</td>
                      <td className="px-3 py-1.5 font-mono">
                        <FactValueDisplay fact={f} unit={property?.unit} display={property?.display} />
                      </td>
                      <td className="px-3 py-1.5">
                        {f.source && isUrl(f.source) ? (
                          <a
                            href={f.source}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                          >
                            {shortDomain(f.source)}
                          </a>
                        ) : f.source ? (
                          <span className="text-xs">{f.source}</span>
                        ) : (
                          <Dash />
                        )}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs">
                        {isCurrent ? (
                          <span className="font-semibold">{f.id}</span>
                        ) : (
                          <FactLink href={`/factbase/fact/${f.id}`}>{f.id}</FactLink>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <FactSourcingDot factId={f.id} sourceUrl={f.source} size="sm" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Debug Info */}
      <SectionHeader>Debug Info</SectionHeader>
      <KVTable>
        <KVRow label="Fact ID">
          <span className="font-mono text-xs">{fact.id}</span>
        </KVRow>
        <KVRow label="Subject ID">
          <span className="font-mono text-xs">{fact.subjectId}</span>
        </KVRow>
        <KVRow label="Property ID">
          <span className="font-mono text-xs">{fact.propertyId}</span>
        </KVRow>
        <KVRow label="Derived From">
          {fact.derivedFrom ? (
            <span className="font-mono text-xs">{fact.derivedFrom}</span>
          ) : (
            <Dash />
          )}
        </KVRow>
        <KVRow label="YAML File">
          <span className="font-mono text-xs">
            packages/factbase/data/things/{fact.subjectId}.yaml
          </span>
        </KVRow>
      </KVTable>
    </div>
  );

  return content;
}
