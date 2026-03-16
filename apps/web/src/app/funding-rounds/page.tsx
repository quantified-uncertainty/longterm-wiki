import type { Metadata } from "next";
import Link from "next/link";
import { getAllKBRecords } from "@/data/factbase";
import { ProfileStatCard } from "@/components/directory";
import { formatCompactCurrency } from "@/lib/format-compact";
import { resolveEntityLink, INSTRUMENT_COLORS } from "@/lib/record-detail-ui";
import {
  formatKBDate,
  titleCase,
} from "@/components/wiki/factbase/format";

export const metadata: Metadata = {
  title: "Funding Rounds",
  description:
    "Directory of funding rounds tracked in the knowledge base, including venture capital, grants, and other financing events for AI-related companies.",
};

interface FundingRoundRow {
  key: string;
  name: string;
  companyName: string;
  companyHref: string | null;
  date: string | null;
  raised: number | null;
  valuation: number | null;
  instrument: string | null;
  leadInvestorName: string;
  leadInvestorHref: string | null;
}

export default function FundingRoundsPage() {
  const allRecords = getAllKBRecords("funding-rounds");

  const rows: FundingRoundRow[] = allRecords.map((record) => {
    const f = record.fields;
    const company = resolveEntityLink(record.ownerEntityId);
    const leadInvestorId =
      typeof f.lead_investor === "string" ? f.lead_investor : null;
    const leadInvestor = leadInvestorId
      ? resolveEntityLink(leadInvestorId)
      : { name: "", href: null };

    return {
      key: record.key,
      name: typeof f.name === "string" ? f.name : record.key,
      companyName: company.name,
      companyHref: company.href,
      date: typeof f.date === "string" ? f.date : null,
      raised: typeof f.raised === "number" ? f.raised : null,
      valuation: typeof f.valuation === "number" ? f.valuation : null,
      instrument: typeof f.instrument === "string" ? f.instrument : null,
      leadInvestorName: leadInvestor.name,
      leadInvestorHref: leadInvestor.href,
    };
  });

  // Sort by date descending, then by raised amount descending
  rows.sort((a, b) => {
    if (a.date && b.date) return b.date.localeCompare(a.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return (b.raised ?? 0) - (a.raised ?? 0);
  });

  // Summary stats
  const totalRounds = rows.length;
  const totalRaised = rows.reduce((sum, r) => sum + (r.raised ?? 0), 0);
  const uniqueCompanies = new Set(rows.map((r) => r.companyName)).size;
  const withValuation = rows.filter((r) => r.valuation != null).length;

  const stats = [
    { label: "Funding Rounds", value: totalRounds.toLocaleString() },
    { label: "Total Raised", value: formatCompactCurrency(totalRaised) },
    { label: "Companies", value: String(uniqueCompanies) },
    { label: "With Valuation", value: String(withValuation) },
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

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      {/* Table */}
      {totalRounds > 0 ? (
        <div className="border border-border/60 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                <th className="text-left py-2.5 px-3 font-medium">Round</th>
                <th className="text-left py-2.5 px-3 font-medium">Company</th>
                <th className="text-right py-2.5 px-3 font-medium">Raised</th>
                <th className="text-right py-2.5 px-3 font-medium">
                  Valuation
                </th>
                <th className="text-left py-2.5 px-3 font-medium">
                  Instrument
                </th>
                <th className="text-left py-2.5 px-3 font-medium">
                  Lead Investor
                </th>
                <th className="text-center py-2.5 px-3 font-medium">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className="hover:bg-muted/20 transition-colors"
                >
                  <td className="py-2 px-3">
                    <Link
                      href={`/funding-rounds/${row.key}`}
                      className="font-medium text-foreground text-xs hover:text-primary transition-colors"
                    >
                      {row.name}
                    </Link>
                  </td>
                  <td className="py-2 px-3 text-xs">
                    {row.companyHref ? (
                      <Link
                        href={row.companyHref}
                        className="text-primary hover:underline"
                      >
                        {row.companyName}
                      </Link>
                    ) : (
                      <span className="text-foreground">{row.companyName}</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                    {row.raised != null && (
                      <span className="font-semibold">
                        {formatCompactCurrency(row.raised)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs text-muted-foreground">
                    {row.valuation != null &&
                      formatCompactCurrency(row.valuation)}
                  </td>
                  <td className="py-2 px-3 text-xs">
                    {row.instrument && (
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          INSTRUMENT_COLORS[row.instrument] ??
                          "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                        }`}
                      >
                        {titleCase(row.instrument)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-xs">
                    {row.leadInvestorHref ? (
                      <Link
                        href={row.leadInvestorHref}
                        className="text-primary hover:underline"
                      >
                        {row.leadInvestorName}
                      </Link>
                    ) : row.leadInvestorName ? (
                      <span className="text-muted-foreground">
                        {row.leadInvestorName}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 px-3 text-center text-muted-foreground text-xs whitespace-nowrap">
                    {row.date ? formatKBDate(row.date) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
