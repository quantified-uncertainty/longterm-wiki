"use client";

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

interface ThingRow {
  id: string;
  thingType: string;
  title: string;
  parentThingId: string | null;
  sourceTable: string;
  sourceId: string;
  entityType: string | null;
  description: string | null;
  href: string | null;
  parentTitle: string | null;
  updatedAt: string | null;
}

interface ThingsStatsResponse {
  total: number;
  byType: Record<string, number>;
  byEntityType: Record<string, number>;
}

interface ThingsTableProps {
  rows: ThingRow[];
  total: number;
  stats: ThingsStatsResponse;
  currentQuery: string;
  currentType: string;
  currentPage: number;
  pageSize: number;
}

/** Format a thingType value as a readable badge label. */
function formatType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
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
  funding_program: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
  personnel: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
};

const DEFAULT_TYPE_COLOR = "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";

export function ThingsTable({
  rows,
  total,
  stats,
  currentQuery,
  currentType,
  currentPage,
  pageSize,
}: ThingsTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const updateUrl = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      // Reset page when filters change
      const query = params.toString();
      router.push(`/things${query ? `?${query}` : ""}`, { scroll: false });
    },
    [router, searchParams],
  );

  // Sort types by count descending, take top 8
  const typeEntries = Object.entries(stats.byType)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);

  return (
    <div>
      {/* Search input */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50" />
          <input
            type="text"
            placeholder="Search things..."
            aria-label="Search things"
            defaultValue={currentQuery}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const value = (e.target as HTMLInputElement).value;
                updateUrl({ q: value || null, page: null });
              }
            }}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border bg-card placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40"
          />
        </div>
        <span className="text-sm text-muted-foreground whitespace-nowrap tabular-nums">
          {total.toLocaleString()} results
        </span>
      </div>

      {/* Type filter badges */}
      <div className="flex gap-1.5 flex-wrap mb-4">
        <button
          type="button"
          onClick={() => updateUrl({ type: null, page: null })}
          className={cn(
            "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
            !currentType
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:bg-muted/80",
          )}
        >
          All ({stats.total.toLocaleString()})
        </button>
        {typeEntries.map(([type, count]) => (
          <button
            key={type}
            type="button"
            onClick={() =>
              updateUrl({
                type: currentType === type ? null : type,
                page: null,
              })
            }
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              currentType === type
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            )}
          >
            {formatType(type)} ({count.toLocaleString()})
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted">
              <th className="py-2.5 px-3 text-left font-medium w-24">Type</th>
              <th className="py-2.5 px-3 text-left font-medium">Title</th>
              <th className="py-2.5 px-3 text-left font-medium w-48">Parent</th>
              <th className="py-2.5 px-3 text-left font-medium w-32">Updated</th>
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
    </div>
  );
}
