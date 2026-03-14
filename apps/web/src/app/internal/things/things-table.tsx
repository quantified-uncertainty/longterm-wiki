"use client";

import { useState, useCallback, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import type { ColumnDef, SortingState, ExpandedState } from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getExpandedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search, ChevronRight, Loader2, ExternalLink } from "lucide-react";
import { cn } from "@lib/utils";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThingRow {
  id: string;
  thingType: string;
  title: string;
  parentThingId: string | null;
  parentTitle?: string;
  sourceTable: string;
  sourceId: string;
  entityType: string | null;
  description: string | null;
  sourceUrl: string | null;
  numericId: string | null;
  verdict: string | null;
  verdictConfidence: number | null;
  childrenCount?: number;
  href?: string;
}

interface ThingDetail {
  children: ThingRow[];
  childrenTotal: number;
  verdict: {
    verdict: string;
    confidence: number | null;
    reasoning: string | null;
    sourcesChecked: number | null;
    needsRecheck: boolean;
  } | null;
}

type DetailCacheEntry =
  | { status: "loading" }
  | { status: "loaded"; data: ThingDetail }
  | { status: "error"; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verdictBadge(verdict: string | null) {
  if (!verdict) return <span className="text-muted-foreground text-xs">-</span>;
  const colors: Record<string, string> = {
    confirmed: "bg-green-100 text-green-800",
    contradicted: "bg-red-100 text-red-800",
    partial: "bg-yellow-100 text-yellow-800",
    outdated: "bg-orange-100 text-orange-800",
    unverifiable: "bg-gray-100 text-gray-600",
    unchecked: "bg-gray-50 text-gray-500",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[verdict] || "bg-gray-100 text-gray-600"}`}
    >
      {verdict}
    </span>
  );
}

function thingTypeBadge(type: string) {
  const colors: Record<string, string> = {
    entity: "bg-blue-100 text-blue-800",
    resource: "bg-purple-100 text-purple-800",
    grant: "bg-green-100 text-green-800",
    personnel: "bg-orange-100 text-orange-800",
    division: "bg-teal-100 text-teal-800",
    "funding-round": "bg-yellow-100 text-yellow-800",
    investment: "bg-indigo-100 text-indigo-800",
    benchmark: "bg-pink-100 text-pink-800",
    "benchmark-result": "bg-rose-100 text-rose-800",
    "equity-position": "bg-cyan-100 text-cyan-800",
    "funding-program": "bg-lime-100 text-lime-800",
    "division-personnel": "bg-amber-100 text-amber-800",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[type] || "bg-gray-100 text-gray-600"}`}
    >
      {type}
    </span>
  );
}

function expandToggleColumn(): ColumnDef<ThingRow> {
  return {
    id: "expand",
    size: 32,
    header: () => null,
    cell: ({ row }) => (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          row.toggleExpanded();
        }}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label={row.getIsExpanded() ? "Collapse" : "Expand"}
      >
        <ChevronRight
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            row.getIsExpanded() && "rotate-90"
          )}
        />
      </button>
    ),
  };
}

// ---------------------------------------------------------------------------
// Expanded Detail Component
// ---------------------------------------------------------------------------

function ThingExpandedDetail({
  thingId,
  parentThingId,
  parentTitle,
  sourceTable,
  cache,
  onLoad,
}: {
  thingId: string;
  parentThingId: string | null;
  parentTitle?: string;
  sourceTable: string;
  cache: Record<string, DetailCacheEntry>;
  onLoad: (id: string) => void;
}) {
  useEffect(() => {
    if (!cache[thingId]) {
      onLoad(thingId);
    }
  }, [thingId, cache, onLoad]);

  const entry = cache[thingId];

  if (!entry || entry.status === "loading") {
    return (
      <div className="p-4 bg-muted/30 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading details...
      </div>
    );
  }

  if (entry.status === "error") {
    return (
      <div className="p-4 bg-muted/30 text-sm">
        <span className="text-red-600">Failed to load details: {entry.message}</span>
        <button
          type="button"
          onClick={() => onLoad(thingId)}
          className="ml-2 text-xs text-blue-600 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  const { children, childrenTotal, verdict } = entry.data;
  const sourceTableRoutes: Record<string, string> = {
    entities: "/internal/entities",
    grants: "/internal/grants",
    personnel: "/internal/personnel",
    divisions: "/internal/divisions",
    resources: "/internal/resources",
    funding_rounds: "/internal/funding-rounds",
    investments: "/internal/investments",
    equity_positions: "/internal/equity-positions",
    benchmarks: "/internal/benchmarks",
    benchmark_results: "/internal/benchmark-results",
    funding_programs: "/internal/funding-programs",
    division_personnel: "/internal/division-personnel",
  };

  return (
    <div className="p-4 bg-muted/30 space-y-3 text-sm">
      {/* Parent breadcrumb */}
      {parentThingId && (
        <div className="text-xs text-muted-foreground">
          Parent: <span className="font-medium">{parentTitle || parentThingId}</span>
        </div>
      )}

      {/* Verdict */}
      {verdict && (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">Verdict:</span>
          {verdictBadge(verdict.verdict)}
          {verdict.confidence != null && (
            <span className="text-xs text-muted-foreground">
              ({(verdict.confidence * 100).toFixed(0)}% confidence)
            </span>
          )}
          {verdict.sourcesChecked != null && verdict.sourcesChecked > 0 && (
            <span className="text-xs text-muted-foreground">
              {verdict.sourcesChecked} sources checked
            </span>
          )}
          {verdict.needsRecheck && (
            <span className="text-xs text-orange-600 font-medium">needs recheck</span>
          )}
        </div>
      )}

      {/* Children */}
      {childrenTotal > 0 ? (
        <div>
          <div className="text-xs font-medium mb-1">
            Children ({childrenTotal})
          </div>
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Type</th>
                  <th className="px-2 py-1 text-left font-medium">Title</th>
                  <th className="px-2 py-1 text-left font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {children.map((child) => (
                  <tr key={child.id} className="border-t">
                    <td className="px-2 py-1">{thingTypeBadge(child.thingType)}</td>
                    <td className="px-2 py-1 max-w-[300px] truncate">{child.title}</td>
                    <td className="px-2 py-1">{verdictBadge(child.verdict)}</td>
                  </tr>
                ))}
                {childrenTotal > children.length && (
                  <tr className="border-t">
                    <td colSpan={3} className="px-2 py-1 text-muted-foreground italic">
                      ...and {childrenTotal - children.length} more
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {/* Verification rollup */}
          {(() => {
            const verified = children.filter((c) => c.verdict === "confirmed").length;
            const total = children.length;
            const pct = total > 0 ? ((verified / total) * 100).toFixed(0) : "0";
            return (
              <div className="text-xs text-muted-foreground mt-1">
                {verified} of {total} children verified ({pct}%)
              </div>
            );
          })()}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No children</div>
      )}

      {/* Source link */}
      {sourceTableRoutes[sourceTable] && (
        <a
          href={sourceTableRoutes[sourceTable]}
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline no-underline"
        >
          <ExternalLink className="h-3 w-3" />
          View in {sourceTable} table
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const columns: ColumnDef<ThingRow>[] = [
  expandToggleColumn(),
  {
    accessorKey: "thingType",
    header: ({ column }) => (
      <SortableHeader column={column} title="Type">
        Type
      </SortableHeader>
    ),
    cell: ({ row }) => thingTypeBadge(row.original.thingType),
    filterFn: "equalsString",
  },
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column} title="Title">
        Title
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const thing = row.original;
      const displayTitle =
        thing.title.length > 80
          ? thing.title.slice(0, 77) + "..."
          : thing.title;

      if (thing.href) {
        return (
          <a
            href={thing.href}
            className="text-sm font-medium text-accent-foreground hover:underline no-underline max-w-[400px] truncate block"
            title={thing.title}
          >
            {displayTitle}
          </a>
        );
      }

      return (
        <span
          className="text-sm max-w-[400px] truncate block"
          title={thing.title}
        >
          {displayTitle}
        </span>
      );
    },
  },
  {
    accessorKey: "entityType",
    header: ({ column }) => (
      <SortableHeader column={column} title="Entity type">
        Entity Type
      </SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.entityType ? (
        <span className="text-xs text-muted-foreground">
          {row.original.entityType}
        </span>
      ) : null,
  },
  {
    accessorKey: "verdict",
    header: ({ column }) => (
      <SortableHeader column={column} title="Verdict">
        Verdict
      </SortableHeader>
    ),
    cell: ({ row }) => verdictBadge(row.original.verdict),
  },
  {
    accessorKey: "numericId",
    header: "ID",
    cell: ({ row }) =>
      row.original.numericId ? (
        <span className="text-xs font-mono text-muted-foreground">
          E{row.original.numericId}
        </span>
      ) : (
        <span className="text-xs font-mono text-muted-foreground">
          {row.original.id.slice(0, 8)}
        </span>
      ),
  },
  {
    accessorKey: "sourceTable",
    header: "Source",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.sourceTable}
      </span>
    ),
  },
];

// ---------------------------------------------------------------------------
// Server Search Fallback
// ---------------------------------------------------------------------------

function ServerSearchFallback({
  query,
  wikiServerUrl,
}: {
  query: string;
  wikiServerUrl: string;
}) {
  const [results, setResults] = useState<ThingRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const doSearch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `${wikiServerUrl}/api/things/search?q=${encodeURIComponent(query)}&limit=50`
      );
      if (!res.ok) throw new Error("Search failed");
      const data = await res.json();
      setResults(data.results ?? []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, wikiServerUrl]);

  if (results === null) {
    return (
      <div className="text-sm text-muted-foreground mt-2">
        No matches in loaded data.{" "}
        <button
          type="button"
          onClick={doSearch}
          className="text-blue-600 hover:underline"
          disabled={loading}
        >
          {loading ? "Searching..." : "Search all things on server"}
        </button>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="text-sm text-muted-foreground mt-2">
        No results found on server either.
      </div>
    );
  }

  return (
    <div className="mt-4">
      <h3 className="text-sm font-medium mb-2">
        Server search results ({results.length})
      </h3>
      <div className="border rounded-md overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Type</th>
              <th className="px-2 py-1 text-left font-medium">Title</th>
              <th className="px-2 py-1 text-left font-medium">Verdict</th>
              <th className="px-2 py-1 text-left font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-2 py-1">{thingTypeBadge(r.thingType)}</td>
                <td className="px-2 py-1 max-w-[400px] truncate">{r.title}</td>
                <td className="px-2 py-1">{verdictBadge(r.verdict)}</td>
                <td className="px-2 py-1 text-muted-foreground">{r.sourceTable}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ThingsTableProps {
  data: ThingRow[];
  typeFilter?: string;
  wikiServerUrl: string;
}

export function ThingsTable(props: ThingsTableProps) {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Loading table...</div>}>
      <ThingsTableInner {...props} />
    </Suspense>
  );
}

function ThingsTableInner({ data, typeFilter, wikiServerUrl }: ThingsTableProps) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [sorting, setSorting] = useState<SortingState>([
    { id: "title", desc: false },
  ]);
  const [globalFilter, setGlobalFilter] = useState(
    searchParams.get("q") || ""
  );
  const [selectedType, setSelectedType] = useState(
    typeFilter || searchParams.get("type") || ""
  );
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [detailCache, setDetailCache] = useState<Record<string, DetailCacheEntry>>({});

  // Update URL when filters change
  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedType) params.set("type", selectedType);
    if (globalFilter) params.set("q", globalFilter);
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }, [selectedType, globalFilter, router]);

  // Fetch detail for expanded row
  const fetchDetail = useCallback(
    async (thingId: string) => {
      setDetailCache((prev) => ({
        ...prev,
        [thingId]: { status: "loading" },
      }));

      try {
        const [childrenRes, verdictRes] = await Promise.all([
          fetch(
            `${wikiServerUrl}/api/things/children/${encodeURIComponent(thingId)}?limit=20&sort=title&order=asc`
          ),
          fetch(
            `${wikiServerUrl}/api/things/verdicts/${encodeURIComponent(thingId)}`
          ),
        ]);

        const childrenData = childrenRes.ok ? await childrenRes.json() : { things: [], total: 0 };
        const verdictData = verdictRes.ok ? await verdictRes.json() : null;

        setDetailCache((prev) => ({
          ...prev,
          [thingId]: {
            status: "loaded",
            data: {
              children: childrenData.things ?? [],
              childrenTotal: childrenData.total ?? 0,
              verdict: verdictRes.ok ? verdictData : null,
            },
          },
        }));
      } catch (e) {
        setDetailCache((prev) => ({
          ...prev,
          [thingId]: {
            status: "error",
            message: e instanceof Error ? e.message : "Unknown error",
          },
        }));
      }
    },
    [wikiServerUrl]
  );

  // Compute type counts
  const typeCounts: Record<string, number> = {};
  for (const row of data) {
    typeCounts[row.thingType] = (typeCounts[row.thingType] || 0) + 1;
  }

  const filteredData = selectedType
    ? data.filter((r) => r.thingType === selectedType)
    : data;

  const table = useReactTable({
    data: filteredData,
    columns,
    getRowId: (row) => row.id,
    state: { sorting, globalFilter, expanded },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onExpandedChange: setExpanded,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  const visibleRows = table.getRowModel().rows.length;
  const showServerFallback =
    globalFilter.length >= 2 && visibleRows === 0;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search things..."
            aria-label="Search things"
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border rounded-md bg-background"
          />
        </div>

        <select
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
          aria-label="Filter things by type"
          className="px-3 py-2 text-sm border rounded-md bg-background"
        >
          <option value="">All types ({data.length})</option>
          {Object.entries(typeCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => (
              <option key={type} value={type}>
                {type} ({count})
              </option>
            ))}
        </select>
      </div>

      {/* Count */}
      <p className="text-sm text-muted-foreground">
        Showing {visibleRows} of {data.length} things
      </p>

      {/* Table */}
      <DataTable
        table={table}
        renderExpandedRow={(row) => {
          if (!row.getIsExpanded()) return null;
          return (
            <ThingExpandedDetail
              thingId={row.original.id}
              parentThingId={row.original.parentThingId}
              parentTitle={row.original.parentTitle}
              sourceTable={row.original.sourceTable}
              cache={detailCache}
              onLoad={fetchDetail}
            />
          );
        }}
      />

      {/* Server search fallback */}
      {showServerFallback && (
        <ServerSearchFallback
          query={globalFilter}
          wikiServerUrl={wikiServerUrl}
        />
      )}
    </div>
  );
}
