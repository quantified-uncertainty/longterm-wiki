/**
 * Funding Rounds section for organization profile pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { formatCompactCurrency } from "@/lib/format-compact";
import { SectionHeader, safeHref } from "./org-shared";
import type { ParsedFundingRoundRecord } from "./org-data";

export function FundingRoundsSection({
  rounds,
}: {
  rounds: ParsedFundingRoundRecord[];
}) {
  if (rounds.length === 0) return null;

  const totalRaised = rounds.reduce((sum, r) => sum + (r.raised ?? 0), 0);

  return (
    <section>
      <SectionHeader title="Funding Rounds" count={rounds.length} />
      {totalRaised > 0 && (
        <div className="text-xs text-muted-foreground mb-3">
          Total raised: {formatCompactCurrency(totalRaised)}
        </div>
      )}
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
            {rounds.map((r) => (
              <tr key={r.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">{r.name}</span>
                  {r.instrument && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground/60">
                      ({r.instrument})
                    </span>
                  )}
                  {r.source && (
                    <a
                      href={safeHref(r.source)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                    >
                      source
                    </a>
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
                  {r.date ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
