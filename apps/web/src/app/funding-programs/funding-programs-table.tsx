"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { SortHeader } from "@/components/directory/SortHeader";
import { formatCompactCurrency } from "@/lib/format-compact";
import { compareFPRows, type SortDir } from "./funding-programs-sort";
import { FP_STATUS_COLORS, PROGRAM_TYPE_LABELS } from "./funding-programs-constants";

export interface FundingProgramListRow {
  id: string;
  name: string;
  orgId: string;
  orgName: string;
  orgSlug: string | null;
  divisionId: string | null;
  programType: string;
  totalBudget: number | null;
  currency: string;
  applicationUrl: string | null;
  openDate: string | null;
  deadline: string | null;
  status: string | null;
  source: string | null;
  description: string | null;
}

type SortKey = "name" | "organization" | "type" | "budget" | "status" | "deadline";

const PAGE_SIZE = 50;

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

export function FundingProgramsListTable({
  rows,
}: {
  rows: FundingProgramListRow[];
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("budget");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  const statuses = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.status) set.add(r.status);
    }
    return [...set].sort();
  }, [rows]);

  const programTypes = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.programType) set.add(r.programType);
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

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: rows.length };
    for (const r of rows) {
      counts[r.programType] = (counts[r.programType] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(
        key === "name" || key === "organization" || key === "type"
          ? "asc"
          : "desc",
      );
    }
    setPage(0);
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (statusFilter !== "all") {
      result = result.filter((r) => r.status === statusFilter);
    }

    if (typeFilter !== "all") {
      result = result.filter((r) => r.programType === typeFilter);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.orgName.toLowerCase().includes(q) ||
          (r.description && r.description.toLowerCase().includes(q)),
      );
    }

    result = [...result].sort((a, b) => compareFPRows(a, b, sortKey, sortDir));

    return result;
  }, [rows, search, statusFilter, typeFilter, sortKey, sortDir]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col gap-3 mb-5">
        <input
          type="text"
          placeholder="Search programs, organizations..."
          aria-label="Search funding programs"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
        />

        {/* Status filter */}
        <div className="flex flex-wrap gap-1.5">
          <span className="text-xs text-muted-foreground mr-1 self-center">
            Status:
          </span>
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

        {/* Type filter */}
        <div className="flex flex-wrap gap-1.5">
          <span className="text-xs text-muted-foreground mr-1 self-center">
            Type:
          </span>
          <button
            type="button"
            onClick={() => {
              setTypeFilter("all");
              setPage(0);
            }}
            aria-pressed={typeFilter === "all"}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
              typeFilter === "all"
                ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
            }`}
          >
            All
            <span className="ml-1 text-[10px] opacity-60">
              {typeCounts.all}
            </span>
          </button>
          {programTypes.map((t) => (
            <button
              type="button"
              key={t}
              onClick={() => {
                setTypeFilter(typeFilter === t ? "all" : t);
                setPage(0);
              }}
              aria-pressed={typeFilter === t}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                typeFilter === t
                  ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                  : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              {PROGRAM_TYPE_LABELS[t] ?? t}
              <span className="ml-1 text-[10px] opacity-60">
                {typeCounts[t] ?? 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Results count + pagination */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-muted-foreground">
          Showing {filtered.length} of {rows.length} programs
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
              <SortHeader
                label="Program"
                sortKey="name"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              <SortHeader
                label="Organization"
                sortKey="organization"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              <SortHeader
                label="Type"
                sortKey="type"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              <SortHeader
                label="Budget"
                sortKey="budget"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-right"
              />
              <SortHeader
                label="Deadline"
                sortKey="deadline"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-center"
              />
              <SortHeader
                label="Status"
                sortKey="status"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-center"
              />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {pageRows.map((row) => (
              <tr
                key={row.id}
                className="hover:bg-muted/20 transition-colors"
              >
                {/* Name */}
                <td className="py-2.5 px-3">
                  <Link
                    href={`/funding-programs/${row.id}`}
                    className="font-medium text-foreground hover:text-primary transition-colors"
                  >
                    {row.name}
                  </Link>
                  {row.applicationUrl && (
                    <a
                      href={row.applicationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 text-xs text-muted-foreground hover:text-primary transition-colors"
                      title="Apply"
                    >
                      apply
                    </a>
                  )}
                </td>

                {/* Organization */}
                <td className="py-2.5 px-3">
                  {row.orgSlug ? (
                    <Link
                      href={`/organizations/${row.orgSlug}`}
                      className="text-foreground hover:text-primary transition-colors"
                    >
                      {row.orgName}
                    </Link>
                  ) : (
                    <span>{row.orgName}</span>
                  )}
                </td>

                {/* Type */}
                <td className="py-2.5 px-3 text-muted-foreground text-xs">
                  <span className="capitalize">
                    {PROGRAM_TYPE_LABELS[row.programType] ?? row.programType}
                  </span>
                </td>

                {/* Budget */}
                <td className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap">
                  {row.totalBudget != null ? (
                    <span className="font-semibold">
                      {formatCompactCurrency(row.totalBudget)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">{"\u2014"}</span>
                  )}
                </td>

                {/* Deadline */}
                <td className="py-2.5 px-3 text-center text-muted-foreground text-xs">
                  {row.deadline ?? (
                    <span className="text-muted-foreground/40">{"\u2014"}</span>
                  )}
                </td>

                {/* Status */}
                <td className="py-2.5 px-3 text-center">
                  {row.status ? (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        FP_STATUS_COLORS[row.status] ??
                        "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {row.status}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">{"\u2014"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No funding programs match your search.
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
