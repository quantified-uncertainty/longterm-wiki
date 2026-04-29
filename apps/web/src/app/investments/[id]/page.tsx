import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  getAllKBRecords,
  getKBRecords,
} from "@/data/factbase";
import { formatStake } from "@/app/organizations/[slug]/org-data";
import type { KBRecordEntry } from "@/data/factbase";
import { getTypedEntityById, getRecordVerdict } from "@/data/tablebase";
import { formatCompactCurrency } from "@/lib/format-compact";
import { ProfileStatCard } from "@/components/directory";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import { safeHref } from "@/lib/directory-utils";
import {
  resolveEntityLink,
  DetailSection,
  EntityLinkDisplay,
  INSTRUMENT_COLORS,
} from "@/lib/record-detail-ui";
import { getSourcingHref } from "@/app/sourcing/sourcing-shared";
import { SectionHeader } from "@/components/factbase/entity-section-header";
import {
  formatKBDate,
  titleCase,
  isUrl,
  shortDomain,
} from "@/components/wiki/factbase/format";

// ── Types ──────────────────────────────────────────────────────────────

interface ParsedInvestment {
  key: string;
  ownerEntityId: string;
  companyName: string;
  companyHref: string | null;
  investorId: string | null;
  investorName: string;
  investorHref: string | null;
  roundName: string | null;
  date: string | null;
  amount: number | null;
  stakeAcquired: number | null;
  instrument: string | null;
  role: string | null;
  source: string | null;
  notes: string | null;
}

// ── Parsers ───────────────────────────────────────────────────────────

function parseInvestment(record: KBRecordEntry): ParsedInvestment {
  const f = record.fields;
  const company = resolveEntityLink(record.ownerEntityId);
  const investorId = typeof f.investor === "string" ? f.investor : null;
  const investor = investorId
    ? resolveEntityLink(investorId)
    : { name: record.displayName ?? "", href: null };

  return {
    key: record.key,
    ownerEntityId: record.ownerEntityId,
    companyName: company.name,
    companyHref: company.href,
    investorId,
    investorName: investor.name,
    investorHref: investor.href,
    roundName: typeof f.round_name === "string" ? f.round_name : null,
    date: typeof f.date === "string" ? f.date : null,
    amount: typeof f.amount === "number" ? f.amount : null,
    stakeAcquired: typeof f.stake_acquired === "number" ? f.stake_acquired : null,
    instrument: typeof f.instrument === "string" ? f.instrument : null,
    role: typeof f.role === "string" ? f.role : null,
    source: typeof f.source === "string" ? f.source : null,
    notes: typeof f.notes === "string" ? f.notes : null,
  };
}

// ── Metadata ───────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const allInvestments = getAllKBRecords("investments");
  const record = allInvestments.find((r) => r.key === id);
  if (!record) {
    return { title: "Investment Not Found" };
  }
  const investment = parseInvestment(record);
  const companyDisplay = investment.companyName === "Unknown" ? "Undisclosed company" : investment.companyName;
  const parts: string[] = [];
  if (investment.investorName) parts.push(investment.investorName);
  parts.push(`in ${companyDisplay}`);
  if (investment.amount) parts.push(formatCompactCurrency(investment.amount));

  return {
    title: `Investment: ${investment.investorName || "Unknown investor"} in ${companyDisplay} | Investments`,
    description: parts.join(" — "),
  };
}

// ── Role badge colors ─────────────────────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  lead: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  participant: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  founder: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  "co-lead": "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
};

// ── Page ───────────────────────────────────────────────────────────────

export default async function InvestmentDetailPage({ params }: PageProps) {
  const { id } = await params;
  const allInvestments = getAllKBRecords("investments");
  const record = allInvestments.find((r) => r.key === id);

  if (!record) notFound();

  const investment = parseInvestment(record);
  const investmentVerdict = getRecordVerdict("investment", String(investment.key));

  // Company wiki page link
  const companyTypedEntity = getTypedEntityById(investment.ownerEntityId);
  const companyWikiPageId = companyTypedEntity?.wikiId ?? null;

  // Find other investments in the same company
  const otherInSameCompany = allInvestments
    .filter((r) => r.ownerEntityId === investment.ownerEntityId && r.key !== investment.key)
    .map(parseInvestment)
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));

  // Find other investments by the same investor
  const otherBySameInvestor = investment.investorId
    ? allInvestments
        .filter(
          (r) =>
            r.key !== investment.key &&
            typeof r.fields.investor === "string" &&
            r.fields.investor === investment.investorId,
        )
        .map(parseInvestment)
        .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
    : [];

  // Find the funding round record if linked
  let fundingRoundHref: string | null = null;
  if (investment.roundName) {
    const companyRounds = getKBRecords(investment.ownerEntityId, "funding-rounds");
    const matchedRound = companyRounds.find(
      (r) => typeof r.fields.name === "string" && r.fields.name === investment.roundName,
    );
    if (matchedRound) {
      fundingRoundHref = `/funding-rounds/${matchedRound.key}`;
    }
  }

  const companyDisplayName = investment.companyName === "Unknown" ? "Undisclosed company" : investment.companyName;

  const displayTitle = investment.investorName
    ? `${investment.investorName} → ${companyDisplayName}`
    : `Investment in ${companyDisplayName}`;

  const titlePills = (
    <>
      {investment.role && (
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
            ROLE_COLORS[investment.role] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
          }`}
        >
          {titleCase(investment.role)}
        </span>
      )}
      {investment.instrument && (
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
            INSTRUMENT_COLORS[investment.instrument] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
          }`}
        >
          {titleCase(investment.instrument)}
        </span>
      )}
    </>
  );

  const stats: Array<{ label: string; value: string }> = [];
  if (investment.amount != null) {
    stats.push({ label: "Amount", value: formatCompactCurrency(investment.amount) });
  }
  if (investment.stakeAcquired != null) {
    stats.push({ label: "Stake acquired", value: formatStake(investment.stakeAcquired) });
  }
  if (investment.date) {
    stats.push({ label: "Date", value: formatKBDate(investment.date) });
  }

  const statCards = stats.length > 0 && (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {stats.map((s) => (
        <ProfileStatCard key={s.label} {...s} />
      ))}
    </div>
  );

  return (
    <EntityProfileShell
      breadcrumbs={[
        { label: "Organizations", href: "/organizations" },
        ...(investment.companyHref
          ? [{ label: companyDisplayName, href: investment.companyHref }]
          : []),
        { label: investment.investorName ? `Investment by ${investment.investorName}` : "Investment" },
      ]}
      title={displayTitle}
      titlePills={titlePills}
      verdict={investmentVerdict?.verdict ?? null}
      verdictHref={
        investmentVerdict?.verdict
          ? getSourcingHref("investment", String(investment.key))
          : undefined
      }
      statCards={statCards}
    >
      <div className="space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <DetailSection title="Company">
              <EntityLinkDisplay
                name={companyDisplayName}
                href={investment.companyHref}
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

            {(investment.investorId || investment.investorName) && (
              <DetailSection title="Investor">
                <EntityLinkDisplay
                  name={investment.investorName}
                  href={investment.investorHref}
                />
              </DetailSection>
            )}

            {investment.roundName && (
              <DetailSection title="Funding Round">
                {fundingRoundHref ? (
                  <Link
                    href={fundingRoundHref}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    {investment.roundName}
                  </Link>
                ) : (
                  <span className="text-sm text-foreground">{investment.roundName}</span>
                )}
              </DetailSection>
            )}
          </div>

          <div className="space-y-4">
            {investment.source && (
              <DetailSection title="Source">
                {isUrl(investment.source) ? (
                  <a
                    href={safeHref(investment.source)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary hover:underline break-all"
                  >
                    {shortDomain(investment.source)}
                    <span className="text-muted-foreground ml-1">{"↗"}</span>
                  </a>
                ) : (
                  <span className="text-sm text-foreground">{investment.source}</span>
                )}
              </DetailSection>
            )}

            {investment.notes && (
              <DetailSection title="Notes">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {investment.notes}
                </p>
              </DetailSection>
            )}
          </div>
        </div>

        {otherInSameCompany.length > 0 && (
          <RelatedInvestmentsSection
            title={`Other Investments in ${companyDisplayName}`}
            investments={otherInSameCompany.slice(0, 10)}
            totalCount={otherInSameCompany.length}
            showInvestor
          />
        )}

        {otherBySameInvestor.length > 0 && (
          <RelatedInvestmentsSection
            title={`Other Investments by ${investment.investorName}`}
            investments={otherBySameInvestor.slice(0, 10)}
            totalCount={otherBySameInvestor.length}
            showCompany
          />
        )}
      </div>
    </EntityProfileShell>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────

function RelatedInvestmentsSection({
  title,
  investments,
  totalCount,
  showInvestor,
  showCompany,
}: {
  title: string;
  investments: ParsedInvestment[];
  totalCount: number;
  showInvestor?: boolean;
  showCompany?: boolean;
}) {
  return (
    <section>
      <SectionHeader title={title} count={totalCount} />
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              {showInvestor && <th className="text-left py-2 px-3 font-medium">Investor</th>}
              {showCompany && <th className="text-left py-2 px-3 font-medium">Company</th>}
              <th className="text-left py-2 px-3 font-medium">Round</th>
              <th className="text-left py-2 px-3 font-medium">Role</th>
              <th className="text-right py-2 px-3 font-medium">Amount</th>
              <th className="text-center py-2 px-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {investments.map((inv) => (
              <tr key={inv.key} className="hover:bg-muted/20 transition-colors">
                {showInvestor && (
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
                )}
                {showCompany && (
                  <td className="py-2 px-3">
                    <span className="font-medium text-xs">
                      {inv.companyHref ? (
                        <Link href={inv.companyHref} className="text-primary hover:underline">
                          {inv.companyName}
                        </Link>
                      ) : inv.companyName === "Unknown" ? (
                        <span className="text-muted-foreground/60 italic">Undisclosed</span>
                      ) : (
                        <span className="text-foreground">{inv.companyName}</span>
                      )}
                    </span>
                  </td>
                )}
                <td className="py-2 px-3 text-xs text-muted-foreground">
                  {inv.roundName ?? ""}
                </td>
                <td className="py-2 px-3 text-xs text-muted-foreground">
                  {inv.role ? titleCase(inv.role) : ""}
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {inv.amount != null && (
                    <span className="font-semibold">{formatCompactCurrency(inv.amount)}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {inv.date ? formatKBDate(inv.date) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalCount > 10 && (
        <div className="mt-2 text-xs text-muted-foreground text-center">
          Showing 10 of {totalCount} investments
        </div>
      )}
    </section>
  );
}
