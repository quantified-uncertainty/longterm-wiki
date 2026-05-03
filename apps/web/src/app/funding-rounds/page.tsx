import type { Metadata } from "next";
import { getAllKBRecords } from "@/data/factbase";
import { getRecordVerdict } from "@/data/tablebase";
import { ProfileStatCard } from "@/components/directory";
import { formatCompactCurrency } from "@/lib/format-compact";
import { resolveEntityLink } from "@/lib/record-detail-ui";
import { isSid } from "@/lib/stable-id";
import { FundingRoundsTable, type FundingRoundRow } from "./funding-rounds-table";

export const metadata: Metadata = {
  title: "Funding Rounds",
  description:
    "Directory of funding rounds tracked in the knowledge base, including venture capital, grants, and other financing events for AI-related companies.",
};

function filterRawId(name: string | null): string | null {
  if (!name) return null;
  if (isSid(name)) return null;
  return name;
}

export default function FundingRoundsPage() {
  const allRecords = getAllKBRecords("funding-rounds");

  const rows: FundingRoundRow[] = allRecords.map((record) => {
    const f = record.fields;
    const preResolvedCompanyName = filterRawId(
      typeof f.company_name === "string" ? f.company_name : null,
    );
    const company = resolveEntityLink(record.ownerEntityId, preResolvedCompanyName);
    const leadInvestorId =
      typeof f.lead_investor === "string" ? f.lead_investor : null;
    const preResolvedLeadName = filterRawId(
      typeof f.lead_investor_name === "string" ? f.lead_investor_name : null,
    );
    const leadInvestor = leadInvestorId
      ? resolveEntityLink(leadInvestorId, preResolvedLeadName)
      : { name: "", href: null };

    return {
      key: record.key,
      slug: record.slug ?? null,
      name: typeof f.name === "string" ? f.name : record.key,
      companyName: company.name,
      companyHref: company.href,
      date: typeof f.date === "string" ? f.date : null,
      raised: typeof f.raised === "number" ? f.raised : null,
      valuation: typeof f.valuation === "number" ? f.valuation : null,
      instrument: typeof f.instrument === "string" ? f.instrument : null,
      leadInvestorName: leadInvestor.name,
      leadInvestorHref: leadInvestor.href,
      verdict: getRecordVerdict("funding-round", String(record.key)),
    };
  });

  rows.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return (b.raised ?? 0) - (a.raised ?? 0);
  });

  const totalRounds = rows.length;
  const rowsWithRaised = rows.filter((r) => r.raised != null && r.raised > 0);
  const totalRaised = rowsWithRaised.reduce((sum, r) => sum + (r.raised ?? 0), 0);
  const uniqueCompanies = new Set(rows.map((r) => r.companyName)).size;

  const raisedLabel = rowsWithRaised.length < totalRounds
    ? `Total Raised (${rowsWithRaised.length} of ${totalRounds} known)`
    : "Total Raised";

  const stats = [
    { label: "Funding Rounds", value: totalRounds.toLocaleString() },
    { label: raisedLabel, value: rowsWithRaised.length > 0 ? formatCompactCurrency(totalRaised) : "\u2014" },
    { label: "Companies", value: String(uniqueCompanies) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Funding Rounds
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of funding rounds tracked in the knowledge base, including
          venture capital, grants, and other financing events for AI-related
          companies.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      {totalRounds > 0 ? (
        <FundingRoundsTable rows={rows} />
      ) : (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">
            No funding rounds available
          </p>
          <p className="text-sm">
            Funding round data is loaded from the knowledge base during the
            build process.
          </p>
        </div>
      )}
    </div>
  );
}
