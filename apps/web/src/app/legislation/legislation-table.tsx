"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { compareByValue, type SortDir } from "@/lib/sort-utils";
import { SortHeader } from "@/components/directory/SortHeader";
import { STATUS_COLORS, SCOPE_COLORS, normalizeStatus } from "./legislation-constants";

export interface LegislationRow {
  id: string;
  title: string;
  numericId: string | null;
  introduced: string | null;
  policyStatus: string | null;
  /** Normalized status key for badge color. */
  statusKey: string | null;
  author: string | null;
  scope: string | null;
  description: string | null;
  tags: string[];
  sourceCount: number;
  relatedCount: number;
  hasWikiPage: boolean;
}

type SortKey =
  | "title"
  | "introduced"
  | "status"
  | "author"
  | "scope"
  | "sources";

export function LegislationTable({ rows }: { rows: LegislationRow[] }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Unique statuses
  const statuses = useMemo(() => {
    const set = new Map<string, number>();
    for (const r of rows) {
      if (r.statusKey) {
        set.set(r.statusKey, (set.get(r.statusKey) ?? 0) + 1);
      }
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  // Unique scopes
  const scopes = useMemo(() => {
    const set = new Map<string, number>();
    for (const r of rows) {
      if (r.scope) {
        const key = r.scope.toLowerCase();
        set.set(key, (set.get(key) ?? 0) + 1);
      }
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "title" || key === "author" ? "asc" : "desc");
    }
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (statusFilter !== "all") {
      result = result.filter((r) => r.statusKey === statusFilter);
    }

    if (scopeFilter !== "all") {
      result = result.filter(
        (r) => r.scope?.toLowerCase() === scopeFilter,
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((r) => {
        const searchable =
          `${r.title} ${r.author ?? ""} ${r.scope ?? ""} ${r.policyStatus ?? ""} ${r.description ?? ""} ${r.tags.join(" ")}`.toLowerCase();
        return searchable.includes(q);
      });
    }

    const getValue = (row: LegislationRow): string | number | null => {
      switch (sortKey) {
        case "title":
          return row.title.toLowerCase();
        case "introduced":
          return row.introduced;
        case "status":
          return row.statusKey;
        case "author":
          return (row.author ?? "").toLowerCase();
        case "scope":
          return (row.scope ?? "").toLowerCase();
        case "sources":
          return row.sourceCount;
      }
    };
    result = [...result].sort((a, b) =>
      compareByValue(a, b, getValue, sortDir),
    );

    return result;
  }, [rows, search, statusFilter, scopeFilter, sortKey, sortDir]);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col gap-3 mb-5">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="Search legislation..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
          />
          {/* Status filter pills */}
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setStatusFilter("all")}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                statusFilter === "all"
                  ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                  : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              All
              <span className="ml-1 text-[10px] opacity-60">
                {rows.length}
              </span>
            </button>
            {statuses.map(([status, count]) => (
              <button
                key={status}
                onClick={() =>
                  setStatusFilter(statusFilter === status ? "all" : status)
                }
                className={`text-xs px-3 py-1.5 rounded-lg border transition-all capitalize ${
                  statusFilter === status
                    ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                    : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
                }`}
              >
                {status}
                <span className="ml-1 text-[10px] opacity-60">{count}</span>
              </button>
            ))}
          </div>
        </div>
        {/* Scope filter */}
        {scopes.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-xs text-muted-foreground/70 self-center mr-1">
              Scope:
            </span>
            <button
              onClick={() => setScopeFilter("all")}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                scopeFilter === "all"
                  ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                  : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
              }`}
            >
              All
            </button>
            {scopes.map(([scope, count]) => (
              <button
                key={scope}
                onClick={() =>
                  setScopeFilter(scopeFilter === scope ? "all" : scope)
                }
                className={`text-xs px-3 py-1.5 rounded-lg border transition-all capitalize ${
                  scopeFilter === scope
                    ? "bg-primary/10 border-primary/30 text-primary font-semibold"
                    : "border-border/60 bg-card hover:bg-muted/50 text-muted-foreground"
                }`}
              >
                {scope}
                <span className="ml-1 text-[10px] opacity-60">{count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="text-xs text-muted-foreground mb-3">
        Showing {filtered.length} of {rows.length} policies
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted sticky top-0 z-10 backdrop-blur-sm">
              <SortHeader
                label="Legislation"
                sortKey="title"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              <SortHeader
                label="Status"
                sortKey="status"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              <SortHeader
                label="Scope"
                sortKey="scope"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              <SortHeader
                label="Author"
                sortKey="author"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              <SortHeader
                label="Introduced"
                sortKey="introduced"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-left"
              />
              <SortHeader
                label="Sources"
                sortKey="sources"
                currentSort={sortKey}
                currentDir={sortDir}
                onSort={handleSort}
                className="text-right"
              />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {filtered.map((row) => (
              <tr
                key={row.id}
                className="hover:bg-muted/20 transition-colors"
              >
                {/* Title */}
                <td className="py-2.5 px-3 max-w-md">
                  <Link
                    href={`/legislation/${row.id}`}
                    className="font-medium hover:text-primary transition-colors line-clamp-2"
                  >
                    {row.title}
                  </Link>
                  {row.description && (
                    <p className="text-xs text-muted-foreground/70 mt-0.5 line-clamp-1">
                      {row.description}
                    </p>
                  )}
                </td>

                {/* Status */}
                <td className="py-2.5 px-3">
                  {row.statusKey ? (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize whitespace-nowrap ${
                        STATUS_COLORS[row.statusKey] ??
                        "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                      }`}
                    >
                      {row.statusKey}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Scope */}
                <td className="py-2.5 px-3">
                  {row.scope ? (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize whitespace-nowrap ${
                        SCOPE_COLORS[row.scope.toLowerCase()] ??
                        "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                      }`}
                    >
                      {row.scope}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Author */}
                <td className="py-2.5 px-3 text-muted-foreground whitespace-nowrap">
                  {row.author ?? (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Introduced */}
                <td className="py-2.5 px-3 text-muted-foreground whitespace-nowrap">
                  {row.introduced ?? (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Sources */}
                <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">
                  {row.sourceCount > 0 ? (
                    row.sourceCount
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No legislation matches your search.
        </div>
      )}
    </div>
  );
}
