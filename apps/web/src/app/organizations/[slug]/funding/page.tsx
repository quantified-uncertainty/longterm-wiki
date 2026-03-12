import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { resolveOrgBySlug, getOrgSlugs } from "@/app/organizations/org-utils";
import {
  getKBFacts,
  getKBLatest,
} from "@/data/kb";
import { formatKBDate } from "@/components/wiki/kb/format";
import type { Fact } from "@longterm-wiki/kb";

export function generateStaticParams() {
  return getOrgSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = resolveOrgBySlug(slug);
  return {
    title: entity
      ? `Funding History — ${entity.name} | Organizations`
      : "Funding History",
  };
}

function formatAmount(value: unknown): string | null {
  if (value == null) return null;
  const num = typeof value === "number" ? value : Number(value);
  if (isNaN(num)) return String(value);
  if (num >= 1e12) return `$${(num / 1e12).toFixed(1)}T`;
  if (num >= 1e9) return `$${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(0)}M`;
  if (num >= 1e3) return `$${(num / 1e3).toFixed(0)}K`;
  return `$${num.toLocaleString()}`;
}

function isUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

function shortDomain(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url;
  }
}

export default async function OrgFundingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveOrgBySlug(slug);
  if (!entity) return notFound();

  // Records removed — funding round records no longer available
  const valuationFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId === "valuation",
  );
  const totalFundingFact = getKBLatest(entity.id, "total-funding");

  // Sort valuation facts chronologically
  const sortedValuations = [...valuationFacts].sort((a, b) => {
    const da = a.asOf ?? "";
    const db = b.asOf ?? "";
    return da.localeCompare(db);
  });

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      {/* Breadcrumbs */}
      <nav className="text-sm text-muted-foreground mb-4">
        <Link href="/organizations" className="hover:underline">
          Organizations
        </Link>
        <span className="mx-1.5">/</span>
        <Link href={`/organizations/${slug}`} className="hover:underline">
          {entity.name}
        </Link>
        <span className="mx-1.5">/</span>
        <span>Funding</span>
      </nav>

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          {entity.name} — Funding History
        </h1>
        <div className="flex items-center gap-6 text-sm text-muted-foreground">
          {totalFundingFact?.value.type === "number" && (
            <span>
              Total raised:{" "}
              <span className="font-bold text-foreground">
                {formatAmount(totalFundingFact.value.value)}
              </span>
            </span>
          )}
        </div>
      </div>

      {/* Valuation timeline */}
      {sortedValuations.length > 1 && (
        <section className="mb-8">
          <h2 className="text-lg font-bold tracking-tight mb-4">
            Valuation History
          </h2>
          <div className="border border-border/60 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                  <th className="text-left py-2.5 px-4 font-medium">Date</th>
                  <th className="text-right py-2.5 px-4 font-medium">
                    Valuation
                  </th>
                  <th className="text-left py-2.5 px-4 font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {sortedValuations.map((fact) => (
                  <tr key={fact.id}>
                    <td className="py-2.5 px-4 text-muted-foreground">
                      {formatKBDate(fact.asOf)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-bold tabular-nums">
                      {fact.value.type === "number"
                        ? formatAmount(fact.value.value)
                        : ""}
                    </td>
                    <td className="py-2.5 px-4">
                      {fact.source && isUrl(fact.source) ? (
                        <a
                          href={fact.source}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline text-xs"
                        >
                          {shortDomain(fact.source)}
                        </a>
                      ) : fact.source ? (
                        <span className="text-xs text-muted-foreground">
                          {fact.source}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Empty state */}
      {sortedValuations.length <= 1 && (
        <div className="text-center py-16 text-muted-foreground">
          <p className="mb-2">
            No funding data available for {entity.name} yet.
          </p>
          <p className="text-sm mb-4">
            Funding round records are being migrated to PostgreSQL.
          </p>
          <Link
            href={`/organizations/${slug}`}
            className="text-primary hover:underline text-sm"
          >
            &larr; Back to profile
          </Link>
        </div>
      )}
    </div>
  );
}
