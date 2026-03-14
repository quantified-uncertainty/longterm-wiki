"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { SortHeader } from "@/components/directory/SortHeader";
import { formatCompactCurrency, safeHref } from "@/lib/format-compact";
import { compareGrantRows, type SortDir } from "./grants-sort";
import { STATUS_COLORS } from "./grants-constants";

export interface GrantRow {
  /** Composite key: entityId-recordKey for uniqueness */
  compositeKey: string;
  /** The KB record key, used for linking to /grants/[id] */
  recordKey: string;
  name: string;
  /** Grantor entity */
  organizationId: string;
  organizationName: string;
  organizationSlug: string | null;
  organizationWikiPageId: string | null;
  /** Raw recipient identifier (entity ID or plain text) */
  recipient: string | null;
  /** Resolved display name for the recipient */
  recipientName: string | null;
  /** Slug for linking to /organizations/ or /people/ */
  recipientSlug: string | null;
  /** Computed href for the recipient (type-aware: /organizations/ or /people/) */
  recipientHref: string | null;
  /** Numeric wiki page ID for the recipient entity */
  recipientWikiPageId: string | null;
  program: string | null;
  amount: number | null;
  period: string | null;
  date: string | null;
  status: string | null;
  source: string | null;
}

type SortKey = "name" | "organization" | "recipient" | "program" | "amount" | "date" | "status";

const PAGE_SIZE = 100;

function PaginationControls({
  page,
  totalPages,
  totalFiltered,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  totalFiltered: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (totalPages <= 1) return null;
  const start = page * PAGE_SIZE + 1;
  const end = Math.min((page + 1) * PAGE_SIZE, totalFiltered);
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-xs text-muted-foreground tabular-nums">
        {start}&ndash;{end} of {totalFiltered}
      </span>
      <button
        type="button"
        onClick={onPrev}
        disabled={page === 0}
        className="text-xs px-2.5 py-1 rounded border border-border bg-card hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Prev
      </button>
      <span className="text-xs text-muted-foreground tabular-nums">
        {page + 1} / {totalPages}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={page >= totalPages - 1}
        className="text-xs px-2.5 py-1 rounded border border-border bg-card hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Next
      </button>
    </div>
  );
}

export function GrantsTable({ rows }: { rows: GrantRow[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("amount");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  const statuses = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.status) set.add(r.status);
    }
    return [...set].sort();
  }, [rows]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: rows.length };
    for (const r of rows) {
      const s = r.status ?? "unknown";
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" || key === "organization" || key === "recipient" || key === "program" ? "asc" : "desc");
    }
    setPage(0);
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (statusFilter !== "all") {
      result = result.filter((r) => r.status === statusFilter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.organizationName.toLowerCase().includes(q) ||
          (r.recipientName && r.recipientName.toLowerCase().includes(q)) ||
          (r.recipient && r.recipient.toLowerCase().includes(q)) ||
          (r.program && r.program.toLowerCase().includes(q)),
      );
    }

    result = [...result].sort((a, b) => compareGrantRows(a, b, sortKey, sortDir));

    return result;
  }, [rows, search, statusFilter, sortKey, sortDir]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <input
          type="text"
          placeholder="Search grants, recipients, or funders..."
          aria-label="Search grants"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
        />
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => {
              setStatusFilter("all");
              setPage(0);
            }}
            aria-pressed={statusFilter === "all"}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
              statusFilter === "all"
                ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
            }`}
          >
            All
            <span className="ml-1 text-[10px] opacity-60">
              {statusCounts.all}
            </span>
          </button>
          {statuses.map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => {
                setStatusFilter(statusFilter === s ? "all" : s);
                setPage(0);
              }}
              aria-pressed={statusFilter === s}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                statusFilter === s
                  ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                  : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              {s}
              <span className="ml-1 text-[10px] opacity-60">
                {statusCounts[s] ?? 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Results count + pagination */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-muted-foreground">
          Showing {filtered.length} of {rows.length} grants
        </div>
        <PaginationControls
          page={page}
          totalPages={totalPages}
          totalFiltered={filtered.length}
          onPrev={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
        />
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted sticky top-0 z-10 backdrop-blur-sm">
              <SortHeader label="Grant" sortKey="name" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Funder" sortKey="organization" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Recipient" sortKey="recipient" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Program" sortKey="program" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Amount" sortKey="amount" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-right" />
              <SortHeader label="Date" sortKey="date" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
              <SortHeader label="Status" sortKey="status" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {pageRows.map((row) => (
              <tr
                key={row.compositeKey}
                className="hover:bg-muted/20 transition-colors"
              >
                {/* Name */}
                <td className="py-2.5 px-3">
                  <Link
                    href={`/grants/${row.recordKey}`}
                    className="font-medium text-foreground hover:text-primary transition-colors"
                  >
                    {row.name}
                  </Link>
                  {row.source && (
                    <a
                      href={safeHref(row.source)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 text-xs text-muted-foreground hover:text-primary transition-colors"
                      title="Source"
                    >
                      source
                    </a>
                  )}
                </td>

                {/* Funder */}
                <td className="py-2.5 px-3">
                  {row.organizationSlug ? (
                    <Link
                      href={`/organizations/${row.organizationSlug}`}
                      className="text-foreground hover:text-primary transition-colors"
                    >
                      {row.organizationName}
                    </Link>
                  ) : (
                    <span>{row.organizationName}</span>
                  )}
                  {row.organizationWikiPageId && (
                    <Link
                      href={`/wiki/${row.organizationWikiPageId}`}
                      className="ml-2 text-xs text-muted-foreground hover:text-primary transition-colors"
                      title="Wiki page"
                    >
                      wiki
                    </Link>
                  )}
                </td>

                {/* Recipient */}
                <td className="py-2.5 px-3 text-muted-foreground">
                  {row.recipientName ? (
                    row.recipientHref ? (
                      <Link
                        href={row.recipientHref}
                        className="text-foreground hover:text-primary transition-colors"
                      >
                        {row.recipientName}
                      </Link>
                    ) : (
                      <span>{row.recipientName}</span>
                    )
                  ) : (
                    row.recipient ?? ""
                  )}
                  {row.recipientWikiPageId && (
                    <Link
                      href={`/wiki/${row.recipientWikiPageId}`}
                      className="ml-2 text-xs text-muted-foreground hover:text-primary transition-colors"
                      title="Wiki page"
                    >
                      wiki
                    </Link>
                  )}
                </td>

                {/* Program */}
                <td className="py-2.5 px-3 text-muted-foreground text-xs">
                  {row.program ?? <span className="text-muted-foreground/40">{"\u2014"}</span>}
                </td>

                {/* Amount */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.amount != null && (
                    <span className="font-semibold">
                      {formatCompactCurrency(row.amount)}
                    </span>
                  )}
                </td>

                {/* Date */}
                <td className="py-2.5 px-3 text-center text-muted-foreground">
                  {row.date ?? row.period ?? ""}
                </td>

                {/* Status */}
                <td className="py-2.5 px-3 text-center">
                  {row.status && (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        STATUS_COLORS[row.status] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {row.status}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No grants match your search.
        </div>
      )}

      {/* Bottom pagination */}
      <div className="mt-3">
        <PaginationControls
          page={page}
          totalPages={totalPages}
          totalFiltered={filtered.length}
          onPrev={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
        />
      </div>
    </div>
  );
}
