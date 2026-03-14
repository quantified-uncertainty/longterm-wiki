"use client";

import { useState } from "react";
import Link from "next/link";
import { formatCompactCurrency } from "@/lib/format-compact";

// ── Pagination controls ─────────────────────────────────────────────

const PAGE_SIZE = 50;

function PaginationControls({
  page,
  pageCount,
  totalItems,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  totalItems: number;
  onPageChange: (p: number) => void;
}) {
  if (pageCount <= 1) return null;

  const start = page * PAGE_SIZE + 1;
  const end = Math.min((page + 1) * PAGE_SIZE, totalItems);

  return (
    <div className="flex items-center justify-between px-3 py-2 border-t border-border/50 bg-muted/20">
      <span className="text-xs text-muted-foreground tabular-nums">
        {start}&ndash;{end} of {totalItems}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(0)}
          disabled={page === 0}
          className="px-2 py-1 text-xs rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          First
        </button>
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page === 0}
          className="px-2 py-1 text-xs rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Prev
        </button>
        <span className="px-2 py-1 text-xs tabular-nums text-muted-foreground">
          {page + 1} / {pageCount}
        </span>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount - 1}
          className="px-2 py-1 text-xs rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Next
        </button>
        <button
          onClick={() => onPageChange(pageCount - 1)}
          disabled={page >= pageCount - 1}
          className="px-2 py-1 text-xs rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Last
        </button>
      </div>
    </div>
  );
}

// ── Paginated Grants Table ──────────────────────────────────────────

export interface GrantRow {
  key: string;
  name: string;
  recipientName: string;
  recipientHref: string | null;
  amount: number | null;
  date: string | null;
}

export function PaginatedGrantsTable({ grants }: { grants: GrantRow[] }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.ceil(grants.length / PAGE_SIZE);
  const displayed = grants.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalAmount = grants.reduce((sum, g) => sum + (g.amount ?? 0), 0);

  return (
    <div>
      {totalAmount > 0 && (
        <p className="text-xs text-muted-foreground mb-3">
          {formatCompactCurrency(totalAmount)} total
        </p>
      )}
      <div className="border border-border/60 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
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
              {displayed.map((g) => (
                <tr key={g.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2 px-3">
                    <span className="font-medium text-foreground text-xs">
                      {g.name}
                    </span>
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
                    {g.date ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <PaginationControls
          page={page}
          pageCount={pageCount}
          totalItems={grants.length}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}

// ── Paginated Recipients Table ──────────────────────────────────────

export interface RecipientRow {
  name: string;
  href: string | null;
  grantCount: number;
  totalAmount: number;
}

export function PaginatedRecipientsTable({ recipients }: { recipients: RecipientRow[] }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.ceil(recipients.length / PAGE_SIZE);
  const displayed = recipients.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <div className="border border-border/60 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                <th scope="col" className="text-left py-2 px-3 font-medium">Recipient</th>
                <th scope="col" className="text-right py-2 px-3 font-medium">Total Funded</th>
                <th scope="col" className="text-center py-2 px-3 font-medium">Grants</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {displayed.map((r) => (
                <tr key={r.name} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2 px-3">
                    {r.href ? (
                      <Link href={r.href} className="font-medium text-primary text-xs hover:underline">
                        {r.name}
                      </Link>
                    ) : (
                      <span className="font-medium text-foreground text-xs">
                        {r.name}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                    {r.totalAmount > 0 && (
                      <span className="font-semibold">
                        {formatCompactCurrency(r.totalAmount)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-center tabular-nums text-xs text-muted-foreground">
                    {r.grantCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <PaginationControls
          page={page}
          pageCount={pageCount}
          totalItems={recipients.length}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}
