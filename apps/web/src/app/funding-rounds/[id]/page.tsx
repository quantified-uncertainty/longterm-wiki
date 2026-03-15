import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  getAllKBRecords,
  getKBRecords,
} from "@/data/factbase";
import { formatStake } from "@/app/organizations/[slug]/org-data";
import type { KBRecordEntry } from "@/data/factbase";
import { getTypedEntityById, getRecordVerdict } from "@/data/database";
import { formatCompactCurrency } from "@/lib/format-compact";
import { Breadcrumbs } from "@/components/directory";
import { VerificationBadge } from "@/components/directory/VerificationBadge";
import { safeHref } from "@/lib/directory-utils";
import {
  resolveEntityLink,
  DetailSection,
  EntityLinkDisplay,
  INSTRUMENT_COLORS,
} from "@/lib/record-detail-ui";
import {
  formatKBDate,
  titleCase,
  isUrl,
  shortDomain,
} from "@/components/wiki/kb/format";

// ── Types ──────────────────────────────────────────────────────────────

interface ParsedFundingRound {
  key: string;
  ownerEntityId: string;
  name: string;
  companyName: string;
  companyHref: string | null;
  date: string | null;
  raised: number | null;
  valuation: number | null;
  instrument: string | null;
  leadInvestor: string | null;
  leadInvestorName: string;
  leadInvestorHref: string | null;
  source: string | null;
  notes: string | null;
}

interface ParsedInvestment {
  key: string;
  investorName: string;
  investorHref: string | null;
  roundName: string | null;
  date: string | null;
  amount: number | null;
  stakeAcquired: number | null;
  instrument: string | null;
  role: string | null;
  source: string | null;
}

// ── Parsers ───────────────────────────────────────────────────────────

function parseFundingRound(record: KBRecordEntry): ParsedFundingRound {
  const f = record.fields;
  const company = resolveEntityLink(record.ownerEntityId);
  const leadInvestorId = typeof f.lead_investor === "string" ? f.lead_investor : null;
  const leadInvestor = leadInvestorId
    ? resolveEntityLink(leadInvestorId)
    : { name: "", href: null };

  return {
    key: record.key,
    ownerEntityId: record.ownerEntityId,
    name: typeof f.name === "string" ? f.name : record.key,
    companyName: company.name,
    companyHref: company.href,
    date: typeof f.date === "string" ? f.date : null,
    raised: typeof f.raised === "number" ? f.raised : null,
    valuation: typeof f.valuation === "number" ? f.valuation : null,
    instrument: typeof f.instrument === "string" ? f.instrument : null,
    leadInvestor: leadInvestorId,
    leadInvestorName: leadInvestor.name,
    leadInvestorHref: leadInvestor.href,
    source: typeof f.source === "string" ? f.source : null,
    notes: typeof f.notes === "string" ? f.notes : null,
  };
}

function parseInvestment(record: KBRecordEntry): ParsedInvestment {
  const f = record.fields;
  const investorId = typeof f.investor === "string" ? f.investor : null;
  const investor = investorId
    ? resolveEntityLink(investorId)
    : { name: record.displayName ?? "", href: null };

  return {
    key: record.key,
    investorName: investor.name,
    investorHref: investor.href,
    roundName: typeof f.round_name === "string" ? f.round_name : null,
    date: typeof f.date === "string" ? f.date : null,
    amount: typeof f.amount === "number" ? f.amount : null,
    stakeAcquired: typeof f.stake_acquired === "number" ? f.stake_acquired : null,
    instrument: typeof f.instrument === "string" ? f.instrument : null,
    role: typeof f.role === "string" ? f.role : null,
    source: typeof f.source === "string" ? f.source : null,
  };
}

// ── Metadata ───────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const allRounds = getAllKBRecords("funding-rounds");
  const record = allRounds.find((r) => r.key === id);
  if (!record) {
    return { title: "Funding Round Not Found" };
  }
  const round = parseFundingRound(record);
  const parts = [round.name];
  if (round.companyName) parts.push(`by ${round.companyName}`);
  if (round.raised) parts.push(formatCompactCurrency(round.raised));

  return {
    title: `${round.name} | Funding Rounds`,
    description: parts.join(" — "),
  };
}

// ── Page ───────────────────────────────────────────────────────────────

export default async function FundingRoundDetailPage({ params }: PageProps) {
  const { id } = await params;
  const allRounds = getAllKBRecords("funding-rounds");
  const record = allRounds.find((r) => r.key === id);

  if (!record) notFound();

  const round = parseFundingRound(record);
  const roundVerdict = getRecordVerdict("funding-round", String(round.key));

  // Company wiki page link
  const companyTypedEntity = getTypedEntityById(round.ownerEntityId);
  const companyWikiPageId = companyTypedEntity?.numericId ?? null;

  // Find investments in this round
  const companyInvestments = getKBRecords(round.ownerEntityId, "investments");
  const roundInvestments = companyInvestments
    .filter((inv) => {
      const roundName = inv.fields.round_name;
      return typeof roundName === "string" && roundName === round.name;
    })
    .map(parseInvestment);

  // Find other rounds by the same company
  const otherRounds = allRounds
    .filter((r) => r.ownerEntityId === round.ownerEntityId && r.key !== round.key)
    .map(parseFundingRound)
    .sort((a, b) => {
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return (b.raised ?? 0) - (a.raised ?? 0);
    });

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Breadcrumbs */}
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/organizations" },
          ...(round.companyHref
            ? [{ label: round.companyName, href: round.companyHref }]
            : []),
          { label: round.name },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start gap-3 mb-3">
          <h1 className="text-2xl font-extrabold tracking-tight flex-1">
            {round.name}
          </h1>
          {round.instrument && (
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${
                INSTRUMENT_COLORS[round.instrument] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {titleCase(round.instrument)}
            </span>
          )}
          <VerificationBadge verdict={roundVerdict} />
        </div>

        {/* Amount hero */}
        {round.raised != null && (
          <div className="text-3xl font-bold tabular-nums tracking-tight text-primary mb-1">
            {formatCompactCurrency(round.raised)}
            <span className="text-sm font-normal text-muted-foreground ml-2">raised</span>
          </div>
        )}
        {round.valuation != null && (
          <div className="text-lg tabular-nums tracking-tight text-muted-foreground">
            {formatCompactCurrency(round.valuation)}
            <span className="text-sm font-normal ml-2">post-money valuation</span>
          </div>
        )}
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Left column: key details */}
        <div className="space-y-4">
          <DetailSection title="Company">
            <EntityLinkDisplay
              name={round.companyName}
              href={round.companyHref}
            />
            {companyWikiPageId && (
              <Link
                href={`/wiki/${companyWikiPageId}`}
                className="ml-2 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                title="Wiki page"
              >
                wiki
              </Link>
            )}
          </DetailSection>

          {round.leadInvestor && (
            <DetailSection title="Lead Investor">
              <EntityLinkDisplay
                name={round.leadInvestorName}
                href={round.leadInvestorHref}
              />
            </DetailSection>
          )}

          {round.date && (
            <DetailSection title="Date">
              <span className="text-sm text-foreground">
                {formatKBDate(round.date)}
              </span>
            </DetailSection>
          )}
        </div>

        {/* Right column: supplementary info */}
        <div className="space-y-4">
          {round.source && (
            <DetailSection title="Source">
              {isUrl(round.source) ? (
                <a
                  href={safeHref(round.source)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline break-all"
                >
                  {shortDomain(round.source)}
                  <span className="text-muted-foreground ml-1">{"\u2197"}</span>
                </a>
              ) : (
                <span className="text-sm text-foreground">{round.source}</span>
              )}
            </DetailSection>
          )}

          {round.notes && (
            <DetailSection title="Notes">
              <p className="text-sm text-muted-foreground leading-relaxed">
                {round.notes}
              </p>
            </DetailSection>
          )}
        </div>
      </div>

      {/* Investments in this round */}
      {roundInvestments.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-base font-bold tracking-tight">Investors in This Round</h2>
            <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {roundInvestments.length}
            </span>
            <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
          </div>
          <div className="border border-border/60 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                  <th className="text-left py-2 px-3 font-medium">Investor</th>
                  <th className="text-left py-2 px-3 font-medium">Role</th>
                  <th className="text-right py-2 px-3 font-medium">Amount</th>
                  <th className="text-right py-2 px-3 font-medium">Stake</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {roundInvestments.map((inv) => (
                  <tr key={inv.key} className="hover:bg-muted/20 transition-colors">
                    <td className="py-2 px-3">
                      <span className="font-medium text-xs">
                        {inv.investorHref ? (
                          <Link href={inv.investorHref} className="text-primary hover:underline">
                            {inv.investorName}
                          </Link>
                        ) : (
                          <span className="text-foreground">{inv.investorName}</span>
                        )}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-xs text-muted-foreground">
                      {inv.role ? titleCase(inv.role) : ""}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                      {inv.amount != null && (
                        <span className="font-semibold">{formatCompactCurrency(inv.amount)}</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs text-muted-foreground">
                      {inv.stakeAcquired != null && (
                        <span>{formatStake(inv.stakeAcquired)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Other rounds by same company */}
      {otherRounds.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-base font-bold tracking-tight">
              Other Rounds by {round.companyName}
            </h2>
            <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {otherRounds.length}
            </span>
            <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
          </div>
          <div className="border border-border/60 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                  <th className="text-left py-2 px-3 font-medium">Round</th>
                  <th className="text-right py-2 px-3 font-medium">Raised</th>
                  <th className="text-right py-2 px-3 font-medium">Valuation</th>
                  <th className="text-left py-2 px-3 font-medium">Lead Investor</th>
                  <th className="text-center py-2 px-3 font-medium">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {otherRounds.slice(0, 10).map((r) => (
                  <tr key={r.key} className="hover:bg-muted/20 transition-colors">
                    <td className="py-2 px-3">
                      <Link
                        href={`/funding-rounds/${r.key}`}
                        className="font-medium text-foreground text-xs hover:text-primary transition-colors"
                      >
                        {r.name}
                      </Link>
                      {r.instrument && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground/60">
                          ({r.instrument})
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                      {r.raised != null && (
                        <span className="font-semibold">{formatCompactCurrency(r.raised)}</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                      {r.valuation != null && (
                        <span className="text-muted-foreground">{formatCompactCurrency(r.valuation)}</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-xs">
                      {r.leadInvestorHref ? (
                        <Link href={r.leadInvestorHref} className="text-primary hover:underline">
                          {r.leadInvestorName}
                        </Link>
                      ) : r.leadInvestorName ? (
                        <span className="text-muted-foreground">{r.leadInvestorName}</span>
                      ) : null}
                    </td>
                    <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                      {r.date ? formatKBDate(r.date) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {otherRounds.length > 10 && (
            <div className="mt-2 text-xs text-muted-foreground text-center">
              Showing 10 of {otherRounds.length} rounds
            </div>
          )}
        </section>
      )}

      {/* Back to company */}
      <div className="mt-8 pt-6 border-t border-border/60">
        {round.companyHref ? (
          <Link
            href={round.companyHref}
            className="text-sm text-primary hover:underline"
          >
            &larr; Back to {round.companyName}
          </Link>
        ) : (
          <Link
            href="/organizations"
            className="text-sm text-primary hover:underline"
          >
            &larr; Back to organizations
          </Link>
        )}
      </div>
    </div>
  );
}

