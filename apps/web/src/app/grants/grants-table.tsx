"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { SortHeader } from "@/components/directory/SortHeader";
import { CoverageDots } from "@/components/coverage/CoverageDots";
import { computeGrantCoverage } from "@/components/coverage/coverage-score";
import { PaginationControls } from "@/components/directory/PaginationControls";
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
  /** Inferred data source ID (e.g., "coefficient-giving") */
  dataSourceId: string | null;
  /** Inferred data source display name */
  dataSourceName: string | null;
}

type SortKey = "name" | "organization" | "recipient" | "program" | "amount" | "date" | "status";

const PAGE_SIZE = 100;

export interface FunderSummary {
  id: string;
  name: string;
  count: number;
  total: number;
}

export function GrantsTable({
  rows,
  funders,
}: {
  rows: GrantRow[];
  funders: FunderSummary[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [search, setSearch] = useState(() => searchParams.get("search") ?? "");
  const [funderFilter, setFunderFilter] = useState<string>(() => searchParams.get("funder") ?? "all");
  const [dataSourceFilter, setDataSourceFilter] = useState<string>(() => searchParams.get("dataSource") ?? "all");
  const [statusFilter, setStatusFilter] = useState<string>(() => searchParams.get("status") ?? "all");
  const [sortKey, setSortKey] = useState<SortKey>(() => (searchParams.get("sort") as SortKey) || "amount");
  const [sortDir, setSortDir] = useState<SortDir>(() => (searchParams.get("dir") as SortDir) || "desc");
  const [page, setPage] = useState(() => {
    const p = parseInt(searchParams.get("page") ?? "0", 10);
    return Number.isFinite(p) && p >= 0 ? p : 0;
  });

  const updateUrl = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "" || value === "all" || (key === "sort" && value === "amount") || (key === "dir" && value === "desc") || (key === "page" && value === "0")) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      const query = params.toString();
      router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  // Dynamically detect whether status data exists in the dataset.
  // The grant import pipeline currently sets status to null for all PG-sourced
  // grants, so this column is hidden until status data is populated.
  const hasAnyStatus = useMemo(
    () => rows.some((r) => r.status != null),
    [rows],
  );

  const dataSourceOptions = useMemo(() => {
    const dsMap = new Map<string, { name: string; count: number }>();
    for (const r of rows) {
      if (r.dataSourceId && r.dataSourceName) {
        const existing = dsMap.get(r.dataSourceId);
        if (existing) existing.count++;
        else dsMap.set(r.dataSourceId, { name: r.dataSourceName, count: 1 });
      }
    }
    return [...dsMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([id, { name, count }]) => ({ id, name, count }));
  }, [rows]);

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
    let newDir: SortDir;
    if (sortKey === key) {
      newDir = sortDir === "asc" ? "desc" : "asc";
      setSortDir(newDir);
    } else {
      newDir = key === "name" || key === "organization" || key === "recipient" || key === "program" ? "asc" : "desc";
      setSortKey(key);
      setSortDir(newDir);
    }
    setPage(0);
    updateUrl({ sort: key, dir: newDir, page: null });
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (funderFilter !== "all") {
      result = result.filter((r) => r.organizationId === funderFilter);
    }

    if (dataSourceFilter !== "all") {
      result = result.filter((r) => r.dataSourceId === dataSourceFilter);
    }

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
  }, [rows, search, funderFilter, dataSourceFilter, statusFilter, sortKey, sortDir]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      {/* Filters */}
      <div role="search" className="flex flex-col gap-3 mb-5">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="Search grants, recipients, or funders..."
            aria-label="Search grants"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
              updateUrl({ search: e.target.value, page: null });
            }}
            className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
          />
          {/* Status filter — only shown when any grants have status data */}
          {hasAnyStatus && (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setStatusFilter("all");
                  setPage(0);
                  updateUrl({ status: null, page: null });
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
                    const next = statusFilter === s ? "all" : s;
                    setStatusFilter(next);
                    setPage(0);
                    updateUrl({ status: next, page: null });
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
          )}
        </div>

        {/* Data source filter */}
        {dataSourceOptions.length >= 2 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Source:</span>
            <select
              aria-label="Filter by data source"
              value={dataSourceFilter}
              onChange={(e) => {
                setDataSourceFilter(e.target.value);
                setPage(0);
                updateUrl({ dataSource: e.target.value === "all" ? null : e.target.value, page: null });
              }}
              className="text-xs px-2 py-1.5 rounded-lg border border-border bg-card"
            >
              <option value="all">All sources ({rows.length})</option>
              {dataSourceOptions.map(({ id, name, count }) => (
                <option key={id} value={id}>
                  {name} ({count})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Funder filter */}
        {funders.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-xs text-muted-foreground self-center mr-1">Funder:</span>
            <button
              type="button"
              onClick={() => {
                setFunderFilter("all");
                setPage(0);
                updateUrl({ funder: null, page: null });
              }}
              aria-pressed={funderFilter === "all"}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                funderFilter === "all"
                  ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                  : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              All funders
              <span className="ml-1 text-[10px] opacity-60">
                {rows.length}
              </span>
            </button>
            {funders.map((f) => (
              <button
                type="button"
                key={f.id}
                onClick={() => {
                  const next = funderFilter === f.id ? "all" : f.id;
                  setFunderFilter(next);
                  setPage(0);
                  updateUrl({ funder: next, page: null });
                }}
                aria-pressed={funderFilter === f.id}
                className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                  funderFilter === f.id
                    ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                    : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
                }`}
              >
                {f.name}
                <span className="ml-1 text-[10px] opacity-60">
                  {f.count}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Results count + pagination */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-muted-foreground">
          Showing {filtered.length} of {rows.length} grants
        </div>
        <PaginationControls
          page={page}
          pageCount={totalPages}
          totalItems={filtered.length}
          pageSize={PAGE_SIZE}
          onPageChange={(p) => { setPage(p); updateUrl({ page: String(p) }); }}
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
              {hasAnyStatus && (
                <SortHeader label="Status" sortKey="status" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-center" />
              )}
              <th className="py-2.5 px-3 font-medium text-center">Coverage</th>
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
                    href={row.organizationSlug
                      ? `/organizations/${row.organizationSlug}/grants/${row.recordKey}`
                      : `/grants/${row.recordKey}`}
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
                  {row.amount != null && row.amount > 0 ? (
                    <span className="font-semibold">
                      {formatCompactCurrency(row.amount)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">{"\u2014"}</span>
                  )}
                </td>

                {/* Date */}
                <td className="py-2.5 px-3 text-center text-muted-foreground">
                  {row.date ?? row.period ?? <span className="text-muted-foreground/40">{"\u2014"}</span>}
                </td>

                {/* Status — only shown when any grants have status data */}
                {hasAnyStatus && (
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
                )}
                <td className="py-2.5 px-3 text-center">
                  <CoverageDots score={computeGrantCoverage({ amount: row.amount, recipient: row.recipientName, date: row.date, program: row.program, status: row.status, source: row.source })} />
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
          pageCount={totalPages}
          totalItems={filtered.length}
          pageSize={PAGE_SIZE}
          onPageChange={(p) => { setPage(p); updateUrl({ page: String(p) }); }}
        />
      </div>
    </div>
  );
}
