import Link from "next/link";
import { formatCompactCurrency } from "@/lib/directory-utils";
import type { FundingConnection } from "../people-utils";

export function FundingConnections({
  fundingConnections,
}: {
  fundingConnections: FundingConnection[];
}) {
  if (fundingConnections.length === 0) return null;

  const totalAmount = fundingConnections.reduce(
    (sum, c) => sum + (c.amount ?? 0),
    0,
  );
  const gaveCount = fundingConnections.filter(
    (c) => c.direction === "gave",
  ).length;
  const receivedCount = fundingConnections.filter(
    (c) => c.direction === "received" || c.direction === "personal",
  ).length;

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Funding Connections
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {fundingConnections.length}
        </span>
      </h2>
      <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
        {/* Summary stats */}
        <div className="px-5 py-3 bg-muted/30 border-b border-border/40 flex items-center gap-4 text-xs text-muted-foreground">
          {totalAmount > 0 && (
            <span>
              Total:{" "}
              <span className="font-semibold text-foreground">
                {formatCompactCurrency(totalAmount)}
              </span>
            </span>
          )}
          {gaveCount > 0 && (
            <span>
              Gave: <span className="font-medium">{gaveCount}</span>
            </span>
          )}
          {receivedCount > 0 && (
            <span>
              Received: <span className="font-medium">{receivedCount}</span>
            </span>
          )}
        </div>
        <div className="divide-y divide-border/40">
          {fundingConnections.slice(0, 20).map((conn) => (
            <div key={conn.key} className="px-5 py-3.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                    conn.direction === "gave"
                      ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
                      : conn.direction === "personal"
                        ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                        : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                  }`}
                >
                  {conn.direction === "gave"
                    ? "Funded"
                    : conn.direction === "personal"
                      ? "Received"
                      : "Org received"}
                </span>
                <span className="font-semibold text-sm">{conn.name}</span>
                {conn.amount != null && (
                  <span className="text-sm font-semibold tabular-nums text-foreground">
                    {formatCompactCurrency(conn.amount)}
                  </span>
                )}
              </div>
              <div className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                {conn.direction === "gave" && conn.counterparty && (
                  <span>
                    to{" "}
                    {conn.counterparty.href ? (
                      <Link
                        href={conn.counterparty.href}
                        className="hover:text-primary transition-colors"
                      >
                        {conn.counterparty.name}
                      </Link>
                    ) : (
                      conn.counterparty.name
                    )}
                  </span>
                )}
                {(conn.direction === "received" ||
                  conn.direction === "personal") &&
                  conn.counterparty && (
                    <span>
                      from{" "}
                      {conn.counterparty.href ? (
                        <Link
                          href={conn.counterparty.href}
                          className="hover:text-primary transition-colors"
                        >
                          {conn.counterparty.name}
                        </Link>
                      ) : (
                        conn.counterparty.name
                      )}
                    </span>
                  )}
                {conn.viaOrg && (
                  <span className="text-muted-foreground/60">
                    via{" "}
                    {conn.viaOrg.slug ? (
                      <Link
                        href={`/organizations/${conn.viaOrg.slug}`}
                        className="hover:text-primary transition-colors"
                      >
                        {conn.viaOrg.name}
                      </Link>
                    ) : (
                      conn.viaOrg.name
                    )}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground/60">
                {conn.date && <span>{conn.date}</span>}
                {conn.program && (
                  <span className="text-muted-foreground/40">
                    {conn.program}
                  </span>
                )}
                {conn.status && (
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                      conn.status === "active"
                        ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                        : conn.status === "completed"
                          ? "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300"
                          : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {conn.status}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
        {fundingConnections.length > 20 && (
          <div className="px-5 py-3 border-t border-border/40 text-center">
            <span className="text-xs text-muted-foreground">
              Showing 20 of {fundingConnections.length} connections
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
