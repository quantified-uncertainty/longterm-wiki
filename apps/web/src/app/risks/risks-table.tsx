"use client";

import { useMemo } from "react";
import Link from "next/link";
import { SortHeader } from "@/components/directory/SortHeader";
import { FilterChips } from "@/components/directory/FilterChips";
import { PaginationControls } from "@/components/directory/PaginationControls";
import { useDirectoryUrl } from "@/hooks/use-directory-url";
import type { SortDir } from "@/lib/sort-utils";
import {
  RISK_CATEGORY_LABELS,
  RISK_CATEGORY_COLORS,
  SEVERITY_COLORS_DISPLAY,
  LIKELIHOOD_COLORS_DISPLAY,
  DEFAULT_BADGE_COLOR,
} from "./risk-constants";
import { compareRiskRows, type RiskSortKey } from "./risks-sort";

export interface RiskRow {
  id: string;
  name: string;
  numericId: string | null;
  wikiPageId: string | null;
  riskCategory: string | null;
  severity: string | null;
  likelihood: string | null;
  timeHorizon: string | null;
}

const PAGE_SIZE = 50;

export function RisksTable({ rows }: { rows: RiskRow[] }) {
  const url = useDirectoryUrl({
    defaultSort: { field: "name", dir: "asc" },
    filters: ["category"],
  });
  const categoryFilter = url.filters.category ?? "all";
  const sortKey = url.sort.field as RiskSortKey;
  const sortDir: SortDir = url.sort.dir;

  // Collect unique categories for filter
  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const r of rows) {
      if (r.riskCategory) cats.add(r.riskCategory);
    }
    return [...cats].sort();
  }, [rows]);

  // Count by category for badges
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: rows.length };
    for (const r of rows) {
      const c = r.riskCategory ?? "unknown";
      counts[c] = (counts[c] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  const handleSort = (key: RiskSortKey) => {
    const newDir = url.sort.field === key
      ? (url.sort.dir === "asc" ? "desc" : "asc")
      : (key === "name" ? "asc" : "desc");
    url.setSort({ field: key, dir: newDir as "asc" | "desc" });
  };

  const filtered = useMemo(() => {
    let result = rows;

    if (categoryFilter !== "all") {
      result = result.filter((r) => r.riskCategory === categoryFilter);
    }

    if (url.search.trim()) {
      const q = url.search.toLowerCase();
      result = result.filter((r) => {
        const searchable = `${r.name} ${r.riskCategory ?? ""} ${r.severity ?? ""} ${r.likelihood ?? ""} ${r.timeHorizon ?? ""}`.toLowerCase();
        return searchable.includes(q);
      });
    }

    result = [...result].sort((a, b) =>
      compareRiskRows(a, b, sortKey, sortDir),
    );

    return result;
  }, [rows, url.search, categoryFilter, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(url.page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <input
          type="text"
          placeholder="Search risks..."
          aria-label="Search risks"
          value={url.search}
          onChange={(e) => url.setSearch(e.target.value)}
          className="px-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 w-full sm:w-64"
        />
        <FilterChips
          items={categories.map((c) => ({
            key: c,
            label: RISK_CATEGORY_LABELS[c] ?? c,
            count: categoryCounts[c] ?? 0,
          }))}
          selected={categoryFilter}
          onSelect={(key) => url.setFilter("category", key)}
          allCount={categoryCounts.all}
        />
      </div>

      {/* Results count + top pagination */}
      <div className="flex flex-col gap-2 mb-3">
        <div className="text-xs text-muted-foreground">
          Showing {filtered.length} of {rows.length} risks
        </div>
        <PaginationControls
          page={safePage}
          pageCount={pageCount}
          totalItems={filtered.length}
          pageSize={PAGE_SIZE}
          onPageChange={url.setPage}
        />
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted sticky top-0 z-10 backdrop-blur-sm">
              <SortHeader label="Risk" sortKey="name" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Category" sortKey="category" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Severity" sortKey="severity" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Likelihood" sortKey="likelihood" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
              <SortHeader label="Time Horizon" sortKey="timeHorizon" currentSort={sortKey} currentDir={sortDir} onSort={handleSort} className="text-left" />
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
                    href={`/risks/${row.id}`}
                    className="font-medium text-foreground hover:text-primary transition-colors"
                  >
                    {row.name}
                  </Link>
                  {row.wikiPageId && (
                    <Link
                      href={`/wiki/${row.wikiPageId}`}
                      className="ml-2 text-xs text-muted-foreground hover:text-primary transition-colors"
                      title="Wiki page"
                    >
                      wiki
                    </Link>
                  )}
                </td>

                {/* Category */}
                <td className="py-2.5 px-3">
                  {row.riskCategory ? (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        RISK_CATEGORY_COLORS[row.riskCategory] ?? DEFAULT_BADGE_COLOR
                      }`}
                    >
                      {RISK_CATEGORY_LABELS[row.riskCategory] ?? row.riskCategory}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Severity */}
                <td className="py-2.5 px-3">
                  {row.severity ? (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        SEVERITY_COLORS_DISPLAY[row.severity] ?? DEFAULT_BADGE_COLOR
                      }`}
                    >
                      {row.severity}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Likelihood */}
                <td className="py-2.5 px-3">
                  {row.likelihood ? (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        LIKELIHOOD_COLORS_DISPLAY[row.likelihood] ?? DEFAULT_BADGE_COLOR
                      }`}
                    >
                      {row.likelihood}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">&mdash;</span>
                  )}
                </td>

                {/* Time Horizon */}
                <td className="py-2.5 px-3 text-sm">
                  {row.timeHorizon ?? <span className="text-muted-foreground/40">&mdash;</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No risks match your search.
        </div>
      )}

      {/* Bottom pagination */}
      <div className="mt-3">
        <PaginationControls
          page={safePage}
          pageCount={pageCount}
          totalItems={filtered.length}
          pageSize={PAGE_SIZE}
          onPageChange={url.setPage}
        />
      </div>
    </div>
  );
}
