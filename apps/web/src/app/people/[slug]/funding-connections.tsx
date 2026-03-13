import Link from "next/link";
import { formatCompactCurrency } from "@/lib/format-compact";
import type { PersonGrant } from "../people-utils";

const MAX_SHOWN = 8;

function GrantRow({ grant }: { grant: PersonGrant }) {
  const funderHref = grant.funder.slug
    ? `/organizations/${grant.funder.slug}`
    : null;

  return (
    <tr className="hover:bg-muted/20 transition-colors">
      {/* Grant name + source link */}
      <td className="py-2 px-3">
        <span className="font-medium text-foreground text-xs">
          {grant.name}
        </span>
        {grant.source && (
          <a
            href={grant.source}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1.5 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
          >
            source
          </a>
        )}
        {grant.connectionType === "via-org" && grant.viaOrg && (
          <span className="ml-1.5 text-[10px] text-muted-foreground/50">
            via{" "}
            {grant.viaOrg.slug ? (
              <Link
                href={`/organizations/${grant.viaOrg.slug}`}
                className="hover:text-primary transition-colors"
              >
                {grant.viaOrg.name}
              </Link>
            ) : (
              grant.viaOrg.name
            )}
          </span>
        )}
      </td>

      {/* Counterparty: funder for received, recipient for given */}
      <td className="py-2 px-3 text-xs">
        {grant.direction === "received" ? (
          funderHref ? (
            <Link
              href={funderHref}
              className="text-primary hover:underline"
            >
              {grant.funder.name}
            </Link>
          ) : (
            <span className="text-muted-foreground">
              {grant.funder.name}
            </span>
          )
        ) : grant.recipientHref ? (
          <Link
            href={grant.recipientHref}
            className="text-primary hover:underline"
          >
            {grant.recipientName}
          </Link>
        ) : (
          <span className="text-muted-foreground">
            {grant.recipientName ?? "Unknown"}
          </span>
        )}
      </td>

      {/* Amount */}
      <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
        {grant.amount != null && (
          <span className="font-semibold">
            {formatCompactCurrency(grant.amount)}
          </span>
        )}
      </td>

      {/* Date */}
      <td className="py-2 px-3 text-center text-muted-foreground text-xs">
        {grant.date ?? ""}
      </td>
    </tr>
  );
}

function GrantTable({
  grants,
  direction,
}: {
  grants: PersonGrant[];
  direction: "received" | "given";
}) {
  if (grants.length === 0) return null;

  const totalAmount = grants.reduce(
    (sum, g) => sum + (g.amount ?? 0),
    0,
  );
  const shown = grants.slice(0, MAX_SHOWN);
  const remaining = grants.length - shown.length;

  return (
    <div>
      {totalAmount > 0 && (
        <div className="text-xs text-muted-foreground mb-2">
          Total tracked: {formatCompactCurrency(totalAmount)}
        </div>
      )}
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Grant</th>
              <th className="text-left py-2 px-3 font-medium">
                {direction === "received" ? "Funder" : "Recipient"}
              </th>
              <th className="text-right py-2 px-3 font-medium">Amount</th>
              <th className="text-center py-2 px-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {shown.map((g) => (
              <GrantRow key={g.key} grant={g} />
            ))}
          </tbody>
        </table>
      </div>
      {remaining > 0 && (
        <p className="mt-2 text-xs text-muted-foreground text-center">
          +{remaining} more grant{remaining !== 1 ? "s" : ""}
        </p>
      )}
    </div>
  );
}

export function FundingConnections({
  directGrants,
  orgGrantsReceived,
  orgGrantsGiven,
}: {
  directGrants: PersonGrant[];
  orgGrantsReceived: PersonGrant[];
  orgGrantsGiven: PersonGrant[];
}) {
  const totalCount =
    directGrants.length + orgGrantsReceived.length + orgGrantsGiven.length;

  if (totalCount === 0) return null;

  // Merge direct + org-received for "Funding Received" section
  const allReceived = [...directGrants, ...orgGrantsReceived].sort(
    (a, b) => (b.amount ?? 0) - (a.amount ?? 0),
  );

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Funding Connections
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {totalCount}
        </span>
      </h2>

      <div className="space-y-6">
        {/* Grants received (direct + via org) */}
        {allReceived.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground mb-2">
              Funding Received
              {orgGrantsReceived.length > 0 &&
                directGrants.length === 0 && (
                  <span className="font-normal ml-1">
                    (via affiliated organizations)
                  </span>
                )}
            </h3>
            <GrantTable grants={allReceived} direction="received" />
          </div>
        )}

        {/* Grants given (via org) */}
        {orgGrantsGiven.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground mb-2">
              Grants Made
              <span className="font-normal ml-1">
                (via affiliated organizations)
              </span>
            </h3>
            <GrantTable grants={orgGrantsGiven} direction="given" />
          </div>
        )}
      </div>
    </section>
  );
}
