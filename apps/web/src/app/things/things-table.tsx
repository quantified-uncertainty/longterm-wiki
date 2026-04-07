"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDirectoryUrl } from "@/hooks/use-directory-url";
import { SortHeader } from "@/components/directory/SortHeader";
import { FilterChips } from "@/components/directory/FilterChips";
import { PaginationControls } from "@/components/directory/PaginationControls";
import { RecordStatusDots } from "@/components/coverage/RecordStatusDots";
import { computeGenericCoverage } from "@/components/coverage/coverage-score";
import { formatType } from "./types";
import type { ThingRow, ThingsStatsResponse } from "./types";

interface ThingsTableProps {
  rows: ThingRow[];
  total: number;
  totalPages: number;
  stats: ThingsStatsResponse;
  pageSize: number;
}

/** Format an ISO date string to a short date. */
function formatDate(iso: string | null): string {
  if (!iso) return "\u2014";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

const TYPE_COLORS: Record<string, string> = {
  entity: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  fact: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  page: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  resource: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  grant: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  division: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  "funding-program": "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
  funding_program: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
  personnel: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
};

const DEFAULT_TYPE_COLOR = "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";

type SortKey = "thing_type" | "title" | "updated_at";

export function ThingsTable({
  rows,
  total,
  totalPages,
  stats,
  pageSize,
}: ThingsTableProps) {
  const url = useDirectoryUrl({
    defaultSort: { field: "updated_at", dir: "desc" },
    filters: ["type", "source_table"],
  });

  // Sort is ignored by the search API (results ranked by relevance),
  // so we disable sort controls when a search query is active.
  const isSearchActive = url.search.length > 0;
  const VALID_SORT_KEYS = new Set<string>(["thing_type", "title", "updated_at"]);
  const rawField = url.sort.field;
  const sortKey: SortKey = VALID_SORT_KEYS.has(rawField) ? (rawField as SortKey) : "updated_at";
  const sortDir = url.sort.dir;

  const handleSort = (key: SortKey) => {
    if (isSearchActive) return;
    if (sortKey === key) {
      if (sortDir === "asc") {
        url.setSort({ field: key, dir: "desc" });
      } else {
        url.setSort({ field: "updated_at", dir: "desc" });
      }
    } else {
      url.setSort({ field: key, dir: "asc" });
    }
  };

  // Build filter chip items from stats — all types, sorted by count
  const typeFilter = url.filters.type ?? "all";
  const typeEntries = Object.entries(stats.byType)
    .sort(([, a], [, b]) => b - a);

  // Source table dropdown options
  const sourceTableFilter = url.filters.source_table ?? "all";
  const sourceTableEntries = Object.entries(stats.bySourceTable)
    .sort(([, a], [, b]) => b - a);

  return (
    <div>
      {/* Search input + source table filter */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50" />
          <input
            type="text"
            placeholder="Search things..."
            aria-label="Search things"
            value={url.search}
            onChange={(e) => url.setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
          />
        </div>
        {sourceTableEntries.length > 0 && (
          <select
            value={isSearchActive ? "all" : sourceTableFilter}
            onChange={(e) => url.setFilter("source_table", e.target.value)}
            disabled={isSearchActive}
            aria-label="Filter by source table"
            className="text-sm rounded-lg border border-border bg-card px-2 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="all">All tables ({stats.total})</option>
            {sourceTableEntries.map(([table, count]) => (
              <option key={table} value={table}>
                {formatType(table)} ({count})
              </option>
            ))}
          </select>
        )}
        <span className="text-sm text-muted-foreground whitespace-nowrap tabular-nums">
          {total.toLocaleString()} results
        </span>
      </div>

      {/* Type filter chips */}
      <div className="mb-4">
        <FilterChips
          items={typeEntries.map(([type, count]) => ({
            key: type,
            label: formatType(type),
            count,
          }))}
          selected={typeFilter}
          onSelect={(key) => url.setFilter("type", key)}
          allCount={stats.total}
        />
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted">
              {isSearchActive ? (
                <>
                  <th className="py-2.5 px-3 text-left font-medium w-24">Type</th>
                  <th className="py-2.5 px-3 text-left font-medium">Title</th>
                  <th className="py-2.5 px-3 text-left font-medium w-48">Parent</th>
                  <th className="py-2.5 px-3 text-left font-medium w-32">Updated</th>
                  <th className="py-2.5 px-2 w-12" />
                </>
              ) : (
                <>
                  <SortHeader
                    label="Type"
                    sortKey="thing_type"
                    currentSort={sortKey}
                    currentDir={sortDir}
                    onSort={handleSort}
                    className="text-left w-24"
                  />
                  <SortHeader
                    label="Title"
                    sortKey="title"
                    currentSort={sortKey}
                    currentDir={sortDir}
                    onSort={handleSort}
                    className="text-left"
                  />
                  <th className="py-2.5 px-3 text-left font-medium w-48">Parent</th>
                  <SortHeader
                    label="Updated"
                    sortKey="updated_at"
                    currentSort={sortKey}
                    currentDir={sortDir}
                    onSort={handleSort}
                    className="text-left w-32"
                  />
                  <th className="py-2.5 px-2 w-12" />
                </>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {rows.map((row) => (
              <tr
                key={row.id}
                className="hover:bg-muted/20 transition-colors"
              >
                <td className="py-2.5 px-3">
                  <span
                    className={cn(
                      "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold",
                      TYPE_COLORS[row.thingType] ?? DEFAULT_TYPE_COLOR,
                    )}
                  >
                    {formatType(row.thingType)}
                  </span>
                </td>
                <td className="py-2.5 px-3">
                  <Link
                    href={`/things/${encodeURIComponent(row.id)}`}
                    className="font-medium text-foreground hover:text-primary transition-colors"
                  >
                    {row.title}
                  </Link>
                  {row.entityType && (
                    <span className="ml-2 text-[10px] text-muted-foreground/60">
                      {row.entityType}
                    </span>
                  )}
                </td>
                <td className="py-2.5 px-3 text-muted-foreground text-xs truncate max-w-[12rem]">
                  {row.parentTitle ? (
                    row.parentThingId ? (
                      <Link
                        href={`/things/${encodeURIComponent(row.parentThingId)}`}
                        className="hover:text-primary transition-colors"
                      >
                        {row.parentTitle}
                      </Link>
                    ) : (
                      row.parentTitle
                    )
                  ) : (
                    <span className="text-muted-foreground/40">{"\u2014"}</span>
                  )}
                </td>
                <td className="py-2.5 px-3 text-muted-foreground text-xs tabular-nums">
                  {formatDate(row.updatedAt)}
                </td>
                <td className="py-2.5 px-2 text-right">
                  <RecordStatusDots
                    coverageScore={computeGenericCoverage({
                      description: row.description,
                      wikiId: row.wikiId,
                      filledFieldCount:
                        (row.sourceUrl ? 1 : 0) +
                        (row.entityType ? 1 : 0) +
                        (row.parentThingId ? 1 : 0),
                    })}
                    verdict={row.verdict}
                    sourceCheckHref={
                      row.verdict
                        ? `/source-checks/${encodeURIComponent(row.sourceTable)}/${encodeURIComponent(row.sourceId)}`
                        : undefined
                    }
                    size="sm"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No things match your search.
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4">
          <PaginationControls
            page={url.page}
            pageCount={totalPages}
            totalItems={total}
            pageSize={pageSize}
            onPageChange={url.setPage}
          />
        </div>
      )}
    </div>
  );
}
