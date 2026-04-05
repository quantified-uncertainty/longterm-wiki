import type { Metadata } from "next";
import Link from "next/link";
import { getAllKBRecords } from "@/data/factbase";
import { getRecordVerdict } from "@/data/tablebase";
import { ProfileStatCard } from "@/components/directory";
import { formatCompactCurrency } from "@/lib/format-compact";
import { resolveEntityLink, INSTRUMENT_COLORS } from "@/lib/record-detail-ui";
import { SourceCheckDot } from "@/components/verification/SourceCheckDot";
import { recordVerdictToStatus } from "@/components/verification/source-check-status";
import {
  formatKBDate,
  titleCase,
} from "@/components/wiki/factbase/format";

export const metadata: Metadata = {
  title: "Investments",
  description:
    "Directory of investment transactions tracked in the knowledge base, including venture capital investments in AI-related companies.",
};

interface InvestmentRow {
  key: string;
  companyName: string;
  companyHref: string | null;
  investorName: string;
  investorHref: string | null;
  roundName: string | null;
  date: string | null;
  amount: number | null;
  instrument: string | null;
  role: string | null;
  verdictString: string | null;
}

export default function InvestmentsPage() {
  const allRecords = getAllKBRecords("investments");

  const allRows: InvestmentRow[] = allRecords.map((record) => {
    const f = record.fields;
    const company = resolveEntityLink(record.ownerEntityId);
    const investorId =
      typeof f.investor === "string" ? f.investor : null;
    const investor = investorId
      ? resolveEntityLink(investorId)
      : { name: record.displayName ?? "", href: null };

    return {
      key: record.key,
      companyName: company.name,
      companyHref: company.href,
      investorName: investor.name,
      investorHref: investor.href,
      roundName: typeof f.round_name === "string" ? f.round_name : null,
      date: typeof f.date === "string" ? f.date : null,
      amount: typeof f.amount === "number" ? f.amount : null,
      instrument: typeof f.instrument === "string" ? f.instrument : null,
      role: typeof f.role === "string" ? f.role : null,
      verdictString: getRecordVerdict("investment", record.key)?.verdict ?? null,
    };
  });

  // Deduplicate investment rows. The PG data can contain near-duplicate rows
  // (e.g., a "YC round" record with a resolved investor entity link and a
  // "YC batch" record without one). Group by company + investor name
  // (case-insensitive) + round name, keeping the record with the most data
  // (prefer linked investor, then higher amount, then more fields).
  const dedupMap = new Map<string, InvestmentRow>();
  for (const row of allRows) {
    const fp = [
      row.companyName.toLowerCase().trim(),
      row.investorName.toLowerCase().trim(),
      (row.roundName ?? "").toLowerCase().trim(),
    ].join("|");

    const existing = dedupMap.get(fp);
    if (!existing) {
      dedupMap.set(fp, row);
      continue;
    }

    // Prefer the row with an investor link, then higher amount, then more
    // non-null fields as a tiebreaker.
    const score = (r: InvestmentRow) => {
      let s = 0;
      if (r.investorHref) s += 100;
      if (r.companyHref) s += 100;
      if (r.amount != null) s += 10;
      if (r.date) s += 1;
      if (r.instrument) s += 1;
      if (r.role) s += 1;
      return s;
    };
    if (score(row) > score(existing)) {
      dedupMap.set(fp, row);
    }
  }
  const rows = Array.from(dedupMap.values());

  // Sort by amount descending, then date descending
  rows.sort((a, b) => {
    if (a.amount != null && b.amount != null) return b.amount - a.amount;
    if (a.amount != null) return -1;
    if (b.amount != null) return 1;
    if (a.date && b.date) return b.date.localeCompare(a.date);
    return 0;
  });

  const totalInvestments = rows.length;
  const rowsWithAmount = rows.filter((r) => r.amount != null && r.amount > 0);
  const totalAmount = rowsWithAmount.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const uniqueInvestors = new Set(
    rows.filter((r) => r.investorName).map((r) => r.investorName),
  ).size;
  const uniqueCompanies = new Set(rows.map((r) => r.companyName)).size;

  const stats = [
    { label: "Investments", value: totalInvestments.toLocaleString() },
    { label: rowsWithAmount.length < totalInvestments ? `Total (${rowsWithAmount.length} of ${totalInvestments} known)` : "Total Amount", value: formatCompactCurrency(totalAmount) },
    { label: "Investors", value: String(uniqueInvestors) },
    { label: "Companies", value: String(uniqueCompanies) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Investments
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of investment transactions tracked in the knowledge base,
          including venture capital investments in AI-related companies.
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
      {totalInvestments > 0 ? (
        <div className="border border-border/60 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                <th className="text-left py-2.5 px-3 font-medium">Investor</th>
                <th className="text-left py-2.5 px-3 font-medium">Company</th>
                <th className="text-left py-2.5 px-3 font-medium">Round</th>
                <th className="text-right py-2.5 px-3 font-medium">Amount</th>
                <th className="text-left py-2.5 px-3 font-medium">
                  Instrument
                </th>
                <th className="text-left py-2.5 px-3 font-medium">Role</th>
                <th className="text-center py-2.5 px-3 font-medium">Date</th>
                <th className="py-2.5 px-1 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className="hover:bg-muted/20 transition-colors"
                >
                  <td className="py-2 px-3 text-xs">
                    {row.investorHref ? (
                      <Link
                        href={row.investorHref}
                        className="font-medium text-primary hover:underline"
                      >
                        {row.investorName}
                      </Link>
                    ) : row.investorName === "Unknown" ? (
                      <span className="text-muted-foreground/60 italic">Undisclosed</span>
                    ) : (
                      <span className="font-medium text-foreground">
                        {row.investorName}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-xs">
                    {row.companyHref ? (
                      <Link
                        href={row.companyHref}
                        className="text-primary hover:underline"
                      >
                        {row.companyName}
                      </Link>
                    ) : row.companyName === "Unknown" ? (
                      <span className="text-muted-foreground/60 italic">Undisclosed</span>
                    ) : (
                      <span className="text-foreground">{row.companyName}</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {row.roundName ?? ""}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                    {row.amount != null && row.amount > 0 ? (
                      <span className="font-semibold">
                        {formatCompactCurrency(row.amount)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/40">{"—"}</span>
                    )}
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
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {row.role ? titleCase(row.role) : ""}
                  </td>
                  <td className="py-2 px-3 text-center text-muted-foreground text-xs whitespace-nowrap">
                    {row.date ? formatKBDate(row.date) : ""}
                  </td>
                  <td className="py-2 px-1">
                    <SourceCheckDot
                      status={recordVerdictToStatus(row.verdictString)}
                      originalVerdict={row.verdictString}
                      size="md"
                      href={row.verdictString ? `/source-checks/investment/${encodeURIComponent(String(row.key))}` : undefined}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No investments available</p>
          <p className="text-sm">
            Investment data is loaded from the knowledge base during the build
            process.
          </p>
        </div>
      )}
    </div>
  );
}
