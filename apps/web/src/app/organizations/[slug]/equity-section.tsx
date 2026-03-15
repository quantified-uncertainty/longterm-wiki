/**
 * Equity Positions section for organization profile pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { getRecordVerdict } from "@data/tablebase";
import { VerificationBadge } from "@/components/directory/VerificationBadge";
import { SectionHeader, safeHref } from "./org-shared";
import type { ParsedEquityPositionRecord } from "./org-data";
import { formatStake } from "./org-data";

export function EquityPositionsSection({
  positions,
}: {
  positions: ParsedEquityPositionRecord[];
}) {
  if (positions.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Equity Positions" count={positions.length} />
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="text-left py-2 px-3 font-medium">Holder</th>
              <th scope="col" className="text-right py-2 px-3 font-medium">Stake</th>
              <th scope="col" className="text-center py-2 px-3 font-medium">As Of</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {positions.map((pos) => {
              const verdict = getRecordVerdict("equity-position", String(pos.key));
              return (
                <tr key={pos.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2 px-3">
                    <span className="font-medium text-foreground text-xs">
                      {pos.holderHref ? (
                        <Link href={pos.holderHref} className="text-primary hover:underline">
                          {pos.holderName}
                        </Link>
                      ) : (
                        pos.holderName
                      )}
                    </span>
                    {pos.source && (
                      <a
                        href={safeHref(pos.source)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                      >
                        source
                      </a>
                    )}
                    <VerificationBadge verdict={verdict} />
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                    {pos.stake != null && (
                      <span className="font-semibold">{formatStake(pos.stake)}</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                    {pos.asOf ?? <span className="text-muted-foreground/40">{"\u2014"}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
