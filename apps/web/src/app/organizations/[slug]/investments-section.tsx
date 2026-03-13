/**
 * Investments Received section for organization profile pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { formatCompactCurrency } from "@/lib/format-compact";
import { SectionHeader, safeHref } from "./org-shared";
import type { ParsedInvestmentRecord } from "./org-data";

export function InvestmentsReceivedSection({
  investments,
}: {
  investments: ParsedInvestmentRecord[];
}) {
  if (investments.length === 0) return null;

  const totalAmount = investments.reduce((sum, inv) => sum + (inv.amount ?? 0), 0);

  return (
    <section>
      <SectionHeader title="Investments Received" count={investments.length} />
      {totalAmount > 0 && (
        <div className="text-xs text-muted-foreground mb-3">
          Total tracked: {formatCompactCurrency(totalAmount)}
        </div>
      )}
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Investor</th>
              <th className="text-left py-2 px-3 font-medium">Round</th>
              <th className="text-right py-2 px-3 font-medium">Amount</th>
              <th className="text-center py-2 px-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {investments.map((inv) => (
              <tr key={inv.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">
                    {inv.investorHref ? (
                      <Link href={inv.investorHref} className="text-primary hover:underline">
                        {inv.investorName}
                      </Link>
                    ) : (
                      inv.investorName
                    )}
                  </span>
                  {inv.role && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground/60">
                      ({inv.role})
                    </span>
                  )}
                  {inv.source && (
                    <a
                      href={safeHref(inv.source)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                    >
                      source
                    </a>
                  )}
                </td>
                <td className="py-2 px-3 text-xs text-muted-foreground">
                  {inv.roundName ?? ""}
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {inv.amount != null && (
                    <span className="font-semibold">{formatCompactCurrency(inv.amount)}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {inv.date ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
