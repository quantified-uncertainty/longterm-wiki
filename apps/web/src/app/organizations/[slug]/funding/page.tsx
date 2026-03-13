import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { resolveOrgBySlug, getOrgSlugs } from "@/app/organizations/org-utils";
import {
  getKBRecords,
  getKBFacts,
  getKBEntity,
  getKBLatest,
} from "@/data/kb";
import { formatKBDate, isUrl, shortDomain } from "@/components/wiki/kb/format";
import { formatAmount } from "../org-data";
import type { Fact, RecordEntry } from "@longterm-wiki/kb";
import { Breadcrumbs } from "@/components/directory";

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


export default async function OrgFundingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveOrgBySlug(slug);
  if (!entity) return notFound();

  const fundingRounds = getKBRecords(entity.id, "funding-rounds");
  const investments = getKBRecords(entity.id, "investments");
  const valuationFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId === "valuation",
  );
  const totalFundingFact = getKBLatest(entity.id, "total-funding");

  // Sort rounds chronologically (oldest first for timeline)
  const sortedRounds = [...fundingRounds].sort((a, b) => {
    const da = a.fields.date ? String(a.fields.date) : "";
    const db = b.fields.date ? String(b.fields.date) : "";
    return da.localeCompare(db);
  });

  // Cumulative funding
  let cumulative = 0;
  const roundsWithCumulative = sortedRounds.map((round) => {
    const raised =
      round.fields.raised != null ? Number(round.fields.raised) : 0;
    cumulative += raised;
    return { round, cumulativeRaised: cumulative };
  });

  // Group investments by round key
  const investmentsByRound = new Map<string, RecordEntry[]>();
  for (const inv of investments) {
    const roundKey = inv.fields.round_name ? String(inv.fields.round_name) : "__other__";
    const list = investmentsByRound.get(roundKey) ?? [];
    list.push(inv);
    investmentsByRound.set(roundKey, list);
  }

  // Count unique investors (not investment records)
  const uniqueInvestorCount = new Set(
    investments.map(inv => String(inv.fields.investor ?? inv.displayName ?? inv.key)).filter(Boolean)
  ).size;

  // Sort valuation facts chronologically
  const sortedValuations = [...valuationFacts].sort((a, b) => {
    const da = a.asOf ?? "";
    const db = b.asOf ?? "";
    return da.localeCompare(db);
  });

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/organizations" },
          { label: entity.name, href: `/organizations/${slug}` },
          { label: "Funding" },
        ]}
      />

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
          <span>
            {fundingRounds.length} round
            {fundingRounds.length !== 1 ? "s" : ""}
          </span>
          {uniqueInvestorCount > 0 && (
            <span>
              {uniqueInvestorCount} known investor
              {uniqueInvestorCount !== 1 ? "s" : ""}
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
          <div className="border border-border/60 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                  <th scope="col" className="text-left py-2.5 px-4 font-medium">Date</th>
                  <th scope="col" className="text-right py-2.5 px-4 font-medium">
                    Valuation
                  </th>
                  <th scope="col" className="text-left py-2.5 px-4 font-medium">Source</th>
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

      {/* Funding rounds detail */}
      {roundsWithCumulative.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-bold tracking-tight mb-4">
            Funding Rounds
          </h2>
          <div className="space-y-4">
            {[...roundsWithCumulative].reverse().map(({ round, cumulativeRaised }) => {
              const name = (round.fields.name as string) ?? round.key;
              const date = round.fields.date
                ? String(round.fields.date)
                : null;
              const raised = round.fields.raised;
              const valuation = round.fields.valuation;
              const leadInvestor = round.fields.lead_investor
                ? String(round.fields.lead_investor)
                : null;
              const instrument = round.fields.instrument
                ? String(round.fields.instrument)
                : null;
              const notes = round.fields.notes
                ? String(round.fields.notes)
                : null;
              const source = round.fields.source
                ? String(round.fields.source)
                : null;

              const leadEntity = leadInvestor
                ? getKBEntity(leadInvestor)
                : null;

              // Investors for this round
              const roundInvestors =
                investmentsByRound.get(round.key) ?? [];

              return (
                <div
                  key={round.key}
                  className="border border-border/60 rounded-xl bg-card overflow-hidden"
                >
                  {/* Round header */}
                  <div className="px-5 py-4 border-b border-border/40 bg-muted/20">
                    <div className="flex items-baseline gap-3 flex-wrap">
                      <h3 className="text-base font-bold">{name}</h3>
                      {instrument && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                          {instrument}
                        </span>
                      )}
                      {date && (
                        <span className="text-sm text-muted-foreground">
                          {formatKBDate(date)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-baseline gap-6 mt-2 flex-wrap">
                      {raised != null && (
                        <div>
                          <span className="text-xs text-muted-foreground/70 mr-1">
                            Raised
                          </span>
                          <span className="text-lg font-bold tabular-nums">
                            {formatAmount(raised)}
                          </span>
                        </div>
                      )}
                      {valuation != null && (
                        <div>
                          <span className="text-xs text-muted-foreground/70 mr-1">
                            Valuation
                          </span>
                          <span className="text-lg font-bold tabular-nums">
                            {formatAmount(valuation)}
                          </span>
                        </div>
                      )}
                      {cumulativeRaised > 0 && raised != null && (
                        <div>
                          <span className="text-xs text-muted-foreground/70 mr-1">
                            Cumulative
                          </span>
                          <span className="text-sm font-semibold tabular-nums text-muted-foreground">
                            {formatAmount(cumulativeRaised)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Round details */}
                  <div className="px-5 py-3 space-y-2">
                    {leadInvestor && (
                      <div className="text-sm">
                        <span className="text-muted-foreground">
                          Lead investor:{" "}
                        </span>
                        {leadEntity ? (
                          <Link
                            href={`/kb/entity/${leadInvestor}`}
                            className="text-primary hover:underline font-medium"
                          >
                            {leadEntity.name}
                          </Link>
                        ) : (
                          <span className="font-medium">{leadInvestor}</span>
                        )}
                      </div>
                    )}

                    {roundInvestors.length > 0 && (
                      <div className="text-sm">
                        <span className="text-muted-foreground">
                          Investors:{" "}
                        </span>
                        {roundInvestors.map((inv, i) => {
                          const investorId = inv.fields.investor
                            ? String(inv.fields.investor)
                            : null;
                          const investorEntity = investorId
                            ? getKBEntity(investorId)
                            : null;
                          const displayName =
                            investorEntity?.name ??
                            inv.displayName ??
                            investorId ??
                            inv.key;
                          const amount = inv.fields.amount;

                          return (
                            <span key={inv.key}>
                              {i > 0 && ", "}
                              {investorEntity && investorId ? (
                                <Link
                                  href={`/kb/entity/${investorId}`}
                                  className="text-primary hover:underline"
                                >
                                  {displayName}
                                </Link>
                              ) : (
                                <span>{displayName}</span>
                              )}
                              {amount != null && (
                                <span className="text-muted-foreground text-xs ml-1">
                                  ({formatAmount(amount)})
                                </span>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}

                    {notes && (
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {notes}
                      </p>
                    )}

                    {source && isUrl(source) && (
                      <a
                        href={source}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-primary/70 hover:text-primary hover:underline transition-colors"
                      >
                        {shortDomain(source)}
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Empty state */}
      {fundingRounds.length === 0 &&
        investments.length === 0 &&
        valuationFacts.length === 0 && (
          <div className="text-center py-16 text-muted-foreground">
            <p className="mb-2">
              No funding data available for {entity.name} yet.
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
