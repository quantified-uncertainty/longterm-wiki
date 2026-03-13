/**
 * Grants Given / Grants Received sections for organization profile pages.
 *
 * Placed in the main content column with summary stats, expandable tables,
 * and full-width layout. Shows first 10 grants with a "Show all" toggle.
 */
import Link from "next/link";
import { formatCompactCurrency } from "@/lib/format-compact";
import { getRecordVerdict } from "@data/database";
import { VerificationBadge } from "@/components/directory/VerificationBadge";
import { SectionHeader, safeHref } from "./org-shared";
import type { ParsedGrantRecord, ReceivedGrant } from "./org-data";
import { formatAmount, numericValue } from "./org-data";
import { ExpandableGrantsTable } from "./expandable-grants-table";

/** Grants Given section — for orgs that are funders. */
export function GrantsGivenSection({
  grants,
  orgName,
}: {
  grants: ParsedGrantRecord[];
  orgName: string;
}) {
  if (grants.length === 0) return null;

  const totalAmount = grants.reduce(
    (sum, g) => sum + numericValue(g.amount),
    0,
  );

  const rows = grants.map((g) => {
    const verdict = getRecordVerdict("grant", String(g.key));
    return (
      <tr key={g.key} className="hover:bg-muted/20 transition-colors">
        <td className="py-2.5 px-4">
          <span className="font-medium text-foreground text-sm">{g.name}</span>
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
          <VerificationBadge verdict={verdict} />
        </td>
        <td className="py-2.5 px-4 text-sm">
          {g.recipientHref ? (
            <Link
              href={g.recipientHref}
              className="text-primary hover:underline"
            >
              {g.recipientName}
            </Link>
          ) : (
            <span className="text-muted-foreground">{g.recipientName}</span>
          )}
        </td>
        <td className="py-2.5 px-4 text-right tabular-nums whitespace-nowrap text-sm">
          {g.amount != null && (
            <span className="font-semibold">{formatAmount(g.amount)}</span>
          )}
        </td>
        <td className="py-2.5 px-4 text-center text-muted-foreground text-sm">
          {g.date ?? ""}
        </td>
      </tr>
    );
  });

  return (
    <section>
      <SectionHeader title="Grants Given" count={grants.length} />
      <div className="text-sm text-muted-foreground mb-3">
        {grants.length} grant{grants.length !== 1 ? "s" : ""} totaling{" "}
        <span className="font-semibold text-foreground">
          {formatCompactCurrency(totalAmount)}
        </span>
      </div>
      <div className="border border-border/60 rounded-xl overflow-x-auto bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="text-left py-2.5 px-4 font-medium">
                Grant
              </th>
              <th scope="col" className="text-left py-2.5 px-4 font-medium">
                Recipient
              </th>
              <th scope="col" className="text-right py-2.5 px-4 font-medium">
                Amount
              </th>
              <th scope="col" className="text-center py-2.5 px-4 font-medium">
                Date
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            <ExpandableGrantsTable totalCount={grants.length}>
              {rows}
            </ExpandableGrantsTable>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Grants Received section — for orgs that are grantees. */
export function GrantsReceivedSection({
  grants,
}: {
  grants: ReceivedGrant[];
}) {
  if (grants.length === 0) return null;

  const totalAmount = grants.reduce(
    (sum, g) => sum + numericValue(g.amount),
    0,
  );

  const rows = grants.map((g) => {
    const verdict = getRecordVerdict("grant", String(g.key));
    return (
      <tr
        key={`received-${g.key}`}
        className="hover:bg-muted/20 transition-colors"
      >
        <td className="py-2.5 px-4">
          <span className="font-medium text-foreground text-sm">{g.name}</span>
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
          <VerificationBadge verdict={verdict} />
        </td>
        <td className="py-2.5 px-4 text-sm">
          {g.funderHref ? (
            <Link href={g.funderHref} className="text-primary hover:underline">
              {g.funderName}
            </Link>
          ) : (
            <span className="text-muted-foreground">{g.funderName}</span>
          )}
        </td>
        <td className="py-2.5 px-4 text-right tabular-nums whitespace-nowrap text-sm">
          {g.amount != null && (
            <span className="font-semibold">{formatAmount(g.amount)}</span>
          )}
        </td>
        <td className="py-2.5 px-4 text-center text-muted-foreground text-sm">
          {g.date ?? ""}
        </td>
      </tr>
    );
  });

  return (
    <section>
      <SectionHeader title="Grants Received" count={grants.length} />
      <div className="text-sm text-muted-foreground mb-3">
        {grants.length} grant{grants.length !== 1 ? "s" : ""} totaling{" "}
        <span className="font-semibold text-foreground">
          {formatCompactCurrency(totalAmount)}
        </span>
      </div>
      <div className="border border-border/60 rounded-xl overflow-x-auto bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="text-left py-2.5 px-4 font-medium">
                Grant
              </th>
              <th scope="col" className="text-left py-2.5 px-4 font-medium">
                Funder
              </th>
              <th scope="col" className="text-right py-2.5 px-4 font-medium">
                Amount
              </th>
              <th scope="col" className="text-center py-2.5 px-4 font-medium">
                Date
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            <ExpandableGrantsTable totalCount={grants.length}>
              {rows}
            </ExpandableGrantsTable>
          </tbody>
        </table>
      </div>
    </section>
  );
}
