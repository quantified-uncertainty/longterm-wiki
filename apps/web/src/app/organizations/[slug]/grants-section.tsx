/**
 * Grants Made / Funding Received sections for organization profile pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { formatCompactCurrency } from "@/lib/format-compact";
import { SectionHeader, safeHref } from "./org-shared";
import type { ParsedGrantRecord, ReceivedGrant } from "./org-data";
import { MAX_GRANTS_SHOWN, formatAmount, numericValue } from "./org-data";

/** Grants Made section for funder org pages. */
export function GrantsMadeSection({
  grants,
  orgName,
  totalCount,
}: {
  grants: ParsedGrantRecord[];
  orgName: string;
  totalCount: number;
}) {
  if (grants.length === 0) return null;

  const totalAmount = grants.reduce((sum, g) => sum + numericValue(g.amount), 0);

  return (
    <section>
      <SectionHeader title="Grants Made" count={totalCount} />
      {totalAmount > 0 && (
        <div className="text-xs text-muted-foreground mb-3">
          Total tracked: {formatCompactCurrency(totalAmount)}
        </div>
      )}
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="text-left py-2 px-3 font-medium">Grant</th>
              <th scope="col" className="text-left py-2 px-3 font-medium">Recipient</th>
              <th scope="col" className="text-right py-2 px-3 font-medium">Amount</th>
              <th scope="col" className="text-center py-2 px-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {grants.slice(0, MAX_GRANTS_SHOWN).map((g) => (
              <tr key={g.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">{g.name}</span>
                  {g.source && (
                    <a
                      href={safeHref(g.source)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                    >
                      source
                    </a>
                  )}
                </td>
                <td className="py-2 px-3 text-xs">
                  {g.recipientHref ? (
                    <Link href={g.recipientHref} className="text-primary hover:underline">
                      {g.recipientName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{g.recipientName}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {g.amount != null && (
                    <span className="font-semibold">{formatAmount(g.amount)}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {g.date ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalCount > MAX_GRANTS_SHOWN && (
        <Link
          href={`/grants?org=${encodeURIComponent(orgName)}`}
          className="block mt-2 text-xs text-primary hover:underline text-center"
        >
          View all {totalCount} grants &rarr;
        </Link>
      )}
    </section>
  );
}

/** Funding Received section for org pages where org is a grant recipient. */
export function FundingReceivedSection({
  grants,
}: {
  grants: ReceivedGrant[];
}) {
  if (grants.length === 0) return null;

  const totalAmount = grants.reduce((sum, g) => sum + numericValue(g.amount), 0);

  return (
    <section>
      <SectionHeader title="Funding Received" count={grants.length} />
      {totalAmount > 0 && (
        <div className="text-xs text-muted-foreground mb-3">
          Total tracked: {formatCompactCurrency(totalAmount)}
        </div>
      )}
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="text-left py-2 px-3 font-medium">Grant</th>
              <th scope="col" className="text-left py-2 px-3 font-medium">Funder</th>
              <th scope="col" className="text-right py-2 px-3 font-medium">Amount</th>
              <th scope="col" className="text-center py-2 px-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {grants.map((g) => (
              <tr key={`received-${g.key}`} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">{g.name}</span>
                  {g.source && (
                    <a
                      href={safeHref(g.source)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                    >
                      source
                    </a>
                  )}
                </td>
                <td className="py-2 px-3 text-xs">
                  {g.funderHref ? (
                    <Link href={g.funderHref} className="text-primary hover:underline">
                      {g.funderName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{g.funderName}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {g.amount != null && (
                    <span className="font-semibold">{formatAmount(g.amount)}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {g.date ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
