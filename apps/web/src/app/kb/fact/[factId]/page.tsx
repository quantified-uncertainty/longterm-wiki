import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { WikiSidebar, MobileSidebarTrigger } from "@/components/wiki/WikiSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { getKBDataNav } from "@/lib/wiki-nav";
import {
  getKBEntities,
  getKBEntity,
  getKBFacts,
  getKBFactById,
  getKBProperty,
  isFactExpired,
} from "@/data/kb";
import { getEntityHref } from "@/data";
import type { Fact, Property } from "@longterm-wiki/kb";
import { formatKBFactValue, formatKBDate, shortDomain, isUrl } from "@/components/wiki/kb/format";

// ── Static params ────────────────────────────────────────────────────

export function generateStaticParams(): { factId: string }[] {
  const entities = getKBEntities();
  const params: { factId: string }[] = [];

  for (const entity of entities) {
    const facts = getKBFacts(entity.id);
    for (const fact of facts) {
      if (fact.propertyId === "description") continue;
      params.push({ factId: fact.id });
    }
  }

  return params;
}

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

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="px-3 py-2 text-muted-foreground font-medium text-xs uppercase tracking-wide whitespace-nowrap align-top w-40">
        {label}
      </td>
      <td className="px-3 py-2 text-sm">{children}</td>
    </tr>
  );
}

function KVTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <table className="w-full">
        <tbody className="[&>tr:nth-child(even)]:bg-muted/30">{children}</tbody>
      </table>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h2 className="text-base font-semibold mt-6 mb-2">{children}</h2>;
}

function Dash() {
  return <span className="text-muted-foreground">{"\u2014"}</span>;
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

  const formattedValue = formatKBFactValue(fact, property?.unit, property?.display);
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

  const entityHref = entity?.numericId
    ? `/wiki/${entity.numericId}`
    : getEntityHref(fact.subjectId);

  const content = (
    <div>
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4">
        <FactLink href="/wiki/E1019">KB Data</FactLink>
        <span>/</span>
        <FactLink href={`/kb/entity/${fact.subjectId}`}>{entityName}</FactLink>
        <span>/</span>
        <span>{propertyName}</span>
        <span>/</span>
        <span className="font-mono text-xs">{factId}</span>
      </nav>

      {/* Header */}
      <h1 className="text-2xl font-bold mb-1">{formattedValue}</h1>
      <p className="text-sm text-muted-foreground mb-6">
        <FactLink href={`/kb/entity/${fact.subjectId}`}>{entityName}</FactLink>
        {" \u203A "}
        <span>{propertyName}</span>
      </p>

      {/* Core Data */}
      <SectionHeader>Core Data</SectionHeader>
      <KVTable>
        <KVRow label="Entity">
          <FactLink href={`/kb/entity/${fact.subjectId}`}>{entityName}</FactLink>
        </KVRow>
        <KVRow label="Property">
          <FactLink href={`/kb/property/${fact.propertyId}`}>{propertyName}</FactLink>
        </KVRow>
        <KVRow label="Formatted Value">{formattedValue}</KVRow>
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
            <a
              href={fact.source}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline font-mono text-xs break-all"
            >
              {shortDomain(fact.source)}
              <span className="text-muted-foreground ml-1">{"\u2197"}</span>
            </a>
          ) : fact.source ? (
            <span className="font-mono text-xs break-all">{fact.source}</span>
          ) : (
            <Dash />
          )}
        </KVRow>
        <KVRow label="Source Resource">
          {fact.sourceResource ? (
            <FactLink href={getEntityHref(fact.sourceResource)}>
              {fact.sourceResource}
            </FactLink>
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
              {formatKBDate(fact.exchangeRateDate) !== "\u2014"
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
                </tr>
              </thead>
              <tbody>
                {timeSeriesFacts.map((f) => {
                  const isCurrent = f.id === factId;
                  const fValue = formatKBFactValue(f, property?.unit, property?.display);
                  return (
                    <tr
                      key={f.id}
                      className={`border-t border-border ${isCurrent ? "bg-primary/5" : "[&:nth-child(even)]:bg-muted/30"}`}
                    >
                      <td className="px-3 py-1.5">{formatKBDate(f.asOf)}</td>
                      <td className="px-3 py-1.5 font-mono">{fValue}</td>
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
                          <FactLink href={`/kb/fact/${f.id}`}>{f.id}</FactLink>
                        )}
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
            packages/kb/data/things/{fact.subjectId}.yaml
          </span>
        </KVRow>
      </KVTable>
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
