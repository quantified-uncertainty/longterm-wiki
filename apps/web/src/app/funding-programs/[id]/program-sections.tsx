/**
 * Section components for funding program detail pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { formatCompactCurrency } from "@/lib/format-compact";
import {
  formatKBDate,
  titleCase,
} from "@/components/wiki/factbase/format";

import type { ParsedGrant } from "./program-data";

// ── Grants Awarded Section ───────────────────────────────────────────

export function GrantsAwardedSection({
  grants,
  totalGranted,
}: {
  grants: ParsedGrant[];
  totalGranted: number;
}) {
  if (grants.length === 0) return null;

  return (
    <section className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-bold tracking-tight">Grants Awarded</h2>
        <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {grants.length}
        </span>
        {totalGranted > 0 && (
          <span className="text-xs text-muted-foreground">
            Total: {formatCompactCurrency(totalGranted)}
          </span>
        )}
        <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
      </div>
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Grant</th>
              <th className="text-left py-2 px-3 font-medium">Recipient</th>
              <th className="text-right py-2 px-3 font-medium">Amount</th>
              <th className="text-center py-2 px-3 font-medium">Date</th>
              <th className="text-center py-2 px-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {grants.map((g) => (
              <tr key={g.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <Link
                    href={`/grants/${g.key}`}
                    className="font-medium text-foreground text-xs hover:text-primary transition-colors"
                  >
                    {g.name}
                  </Link>
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
                    <span className="font-semibold">
                      {formatCompactCurrency(g.amount)}
                    </span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {g.date ? formatKBDate(g.date) : g.period ?? ""}
                </td>
                <td className="py-2 px-3 text-center text-xs">
                  {g.status && (
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                        g.status === "active"
                          ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                          : g.status === "completed"
                            ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                            : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {titleCase(g.status)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Back to Funder Link ──────────────────────────────────────────────

export function BackToFunderLink({
  funder,
}: {
  funder: { name: string; href: string | null };
}) {
  return (
    <div className="mt-8 pt-6 border-t border-border/60">
      {funder.href ? (
        <Link
          href={funder.href}
          className="text-sm text-primary hover:underline"
        >
          &larr; Back to {funder.name}
        </Link>
      ) : (
        <Link
          href="/organizations"
          className="text-sm text-primary hover:underline"
        >
          &larr; Back to organizations
        </Link>
      )}
    </div>
  );
}
