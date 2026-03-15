"use client";

import { useState, useEffect, useCallback } from "react";
import type { ColumnDef, ExpandedState } from "@tanstack/react-table";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getExpandedRowModel,
  type SortingState,
  type ColumnFiltersState,
} from "@tanstack/react-table";
import { ChevronRight, ChevronLeft, Loader2, Search, RotateCcw } from "lucide-react";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import type { VerdictRow, VerdictDetailResult } from "./factbase-verifications-content";

// ── Verdict badge ─────────────────────────────────────────────────────────────

const VERDICT_BADGE_STYLES: Record<string, string> = {
  confirmed: "bg-emerald-500/15 text-emerald-500",
  contradicted: "bg-red-500/15 text-red-500",
  outdated: "bg-amber-500/15 text-amber-500",
  partial: "bg-amber-400/15 text-amber-600",
  unverifiable: "bg-gray-500/15 text-gray-500",
  unchecked: "bg-gray-400/15 text-gray-400",
};

function VerdictBadge({ verdict }: { verdict: string }) {
  const style = VERDICT_BADGE_STYLES[verdict] || "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style}`}
    >
      {verdict}
    </span>
  );
}

// ── Expand toggle column ─────────────────────────────────────────────────────

function expandToggleColumn<TData>(): ColumnDef<TData> {
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

// ── Columns ───────────────────────────────────────────────────────────────────

const columns: ColumnDef<VerdictRow>[] = [
  expandToggleColumn<VerdictRow>(),
  {
    accessorKey: "entityId",
    header: ({ column }) => (
      <SortableHeader column={column}>Entity</SortableHeader>
    ),
    cell: ({ row }) => {
      const entityId = row.original.entityId;
      if (!entityId) return <span className="text-xs text-muted-foreground">-</span>;
      return (
        <a
          href={`/wiki/${entityId}`}
          className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          {entityId}
        </a>
      );
    },
    filterFn: "includesString",
  },
  {
    accessorKey: "factId",
    header: ({ column }) => (
      <SortableHeader column={column}>Fact</SortableHeader>
    ),
    cell: ({ row }) => {
      const label = row.original.factLabel;
      const factId = row.original.factId;
      return (
        <div className="flex flex-col gap-0.5">
          {label && (
            <span className="text-xs font-medium text-foreground">{label}</span>
          )}
          <span className="text-[11px] font-mono text-muted-foreground">
            {factId}
          </span>
        </div>
      );
    },
    filterFn: "includesString",
  },
  {
    accessorKey: "verdict",
    header: ({ column }) => (
      <SortableHeader column={column}>Verdict</SortableHeader>
    ),
    cell: ({ row }) => <VerdictBadge verdict={row.original.verdict} />,
  },
  {
    accessorKey: "confidence",
    header: ({ column }) => (
      <SortableHeader column={column}>Confidence</SortableHeader>
    ),
    cell: ({ row }) => {
      const c = row.original.confidence;
      if (c == null) return <span className="text-xs text-muted-foreground">-</span>;
      const pct = Math.round(c * 100);
      return (
        <span className="text-sm tabular-nums font-medium">{pct}%</span>
      );
    },
  },
  {
    accessorKey: "reasoning",
    header: "Reasoning",
    cell: ({ row }) => {
      const r = row.original.reasoning;
      if (!r) return <span className="text-xs text-muted-foreground">-</span>;
      return (
        <span className="text-xs text-muted-foreground line-clamp-2 max-w-[300px]" title={r}>
          {r}
        </span>
      );
    },
  },
  {
    accessorKey: "sourcesChecked",
    header: ({ column }) => (
      <SortableHeader column={column}>Sources</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-sm tabular-nums">
        {row.original.sourcesChecked}
      </span>
    ),
  },
  {
    accessorKey: "needsRecheck",
    header: ({ column }) => (
      <SortableHeader column={column}>Recheck</SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.needsRecheck ? (
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-500/15 text-amber-500">
          yes
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">no</span>
      ),
  },
  {
    accessorKey: "lastComputedAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Last Computed</SortableHeader>
    ),
    cell: ({ row }) => {
      const d = row.original.lastComputedAt;
      if (!d) return <span className="text-xs text-muted-foreground">-</span>;
      return (
        <span className="text-xs text-muted-foreground tabular-nums">
          {new Date(d).toLocaleDateString()}
        </span>
      );
    },
  },
];

// ── Expanded row detail ─────────────────────────────────────────────────────

type DetailCache = Record<string, {
  status: "loading" | "error" | "loaded";
  data?: VerdictDetailResult;
  error?: string;
}>;

function ExpandedVerificationDetail({
  factId,
  cache,
  onLoad,
}: {
  factId: string;
  cache: DetailCache;
  onLoad: (factId: string) => void;
}) {
  const entry = cache[factId];

  useEffect(() => {
    if (!entry) {
      onLoad(factId);
    }
  }, [factId, entry, onLoad]);

  if (!entry || entry.status === "loading") {
    return (
      <div className="flex items-center gap-2 px-6 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading verification details...
      </div>
    );
  }

  if (entry.status === "error") {
    return (
      <div className="flex items-center gap-3 px-6 py-4 text-sm text-red-500">
        <span>Failed to load details: {entry.error}</span>
        <button
          type="button"
          onClick={() => onLoad(factId)}
          className="inline-flex items-center gap-1 rounded-md border border-red-300 px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
        >
          <RotateCcw className="h-3 w-3" />
          Retry
        </button>
      </div>
    );
  }

  const verifications = entry.data?.verifications ?? [];

  if (verifications.length === 0) {
    return (
      <div className="px-6 py-4 text-sm text-muted-foreground">
        No per-resource verifications found for this fact.
      </div>
    );
  }

  return (
    <div className="px-6 py-4 bg-muted/30">
      <div className="text-xs font-semibold text-muted-foreground mb-2">
        Per-Resource Verifications ({verifications.length})
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40 text-left text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Resource</th>
              <th className="py-1.5 pr-3 font-medium">Verdict</th>
              <th className="py-1.5 pr-3 font-medium">Confidence</th>
              <th className="py-1.5 pr-3 font-medium">Extracted Value</th>
              <th className="py-1.5 pr-3 font-medium">Model</th>
              <th className="py-1.5 pr-3 font-medium">Primary</th>
              <th className="py-1.5 pr-3 font-medium">Checked At</th>
              <th className="py-1.5 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {verifications.map((v) => (
              <tr key={v.id} className="border-b border-border/20 last:border-0">
                <td className="py-1.5 pr-3 font-mono text-muted-foreground">
                  {v.resourceId}
                </td>
                <td className="py-1.5 pr-3">
                  <VerdictBadge verdict={v.verdict} />
                </td>
                <td className="py-1.5 pr-3 tabular-nums">
                  {v.confidence != null
                    ? `${Math.round(v.confidence * 100)}%`
                    : "-"}
                </td>
                <td className="py-1.5 pr-3 max-w-[200px] truncate" title={v.extractedValue ?? undefined}>
                  {v.extractedValue || (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-muted-foreground">
                  {v.checkerModel || "-"}
                </td>
                <td className="py-1.5 pr-3">
                  {v.isPrimarySource ? (
                    <span className="text-emerald-500 font-medium">yes</span>
                  ) : (
                    <span className="text-muted-foreground">no</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">
                  {v.checkedAt
                    ? new Date(v.checkedAt).toLocaleDateString()
                    : "-"}
                </td>
                <td className="py-1.5 max-w-[250px] truncate text-muted-foreground" title={v.notes ?? undefined}>
                  {v.notes || "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Table component ───────────────────────────────────────────────────────────

export function FactBaseVerificationsTable({ data }: { data: VerdictRow[] }) {
  const [filterVerdict, setFilterVerdict] = useState<string>("all");
  const [detailCache, setDetailCache] = useState<DetailCache>({});

  // Compute unique verdicts for filter buttons
  const verdictCounts = new Map<string, number>();
  for (const row of data) {
    verdictCounts.set(row.verdict, (verdictCounts.get(row.verdict) ?? 0) + 1);
  }
  const verdictTypes = [...verdictCounts.keys()].sort();

  const filtered =
    filterVerdict === "all"
      ? data
      : data.filter((d) => d.verdict === filterVerdict);

  // Table state
  const [sorting, setSorting] = useState<SortingState>([
    { id: "confidence", desc: true },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [expanded, setExpanded] = useState<ExpandedState>({});

  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: 100,
  });

  // Reset to page 1 when search filter changes
  useEffect(() => {
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }, [globalFilter]);

  const table = useReactTable({
    data: filtered,
    columns,
    getRowId: (row) => row.factId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onExpandedChange: setExpanded,
    onPaginationChange: setPagination,
    globalFilterFn: "includesString",
    state: {
      sorting,
      columnFilters,
      globalFilter,
      expanded,
      pagination,
    },
  });

  const fetchDetail = useCallback(
    async (factId: string) => {
      setDetailCache((prev) => ({
        ...prev,
        [factId]: { status: "loading" },
      }));

      try {
        const res = await fetch(
          `/api/factbase-verdict-detail?factId=${encodeURIComponent(factId)}`
        );
        if (!res.ok) {
          throw new Error(`Server returned ${res.status} ${res.statusText}`);
        }
        const json = await res.json();
        setDetailCache((prev) => ({
          ...prev,
          [factId]: { status: "loaded", data: json },
        }));
      } catch (e) {
        const message =
          e instanceof Error ? e.message : String(e);
        console.warn(`Failed to fetch verdict detail for ${factId}: ${message}`);
        setDetailCache((prev) => ({
          ...prev,
          [factId]: { status: "error", error: message },
        }));
      }
    },
    []
  );

  const filteredCount = table.getFilteredRowModel().rows.length;
  const pageCount = table.getPageCount();
  const currentPage = table.getState().pagination.pageIndex + 1;
  const canPrev = table.getCanPreviousPage();
  const canNext = table.getCanNextPage();
  const { pageIndex, pageSize: ps } = table.getState().pagination;
  const rangeStart = pageIndex * ps + 1;
  const rangeEnd = Math.min((pageIndex + 1) * ps, filteredCount);

  return (
    <div className="not-prose space-y-4">
      {/* Verdict filter tabs */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setFilterVerdict("all")}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            filterVerdict === "all"
              ? "bg-foreground text-background"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          All <span className="tabular-nums">({data.length})</span>
        </button>
        {verdictTypes.map((v) => (
          <button
            key={v}
            onClick={() => setFilterVerdict(v)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              filterVerdict === v
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {v}{" "}
            <span className="tabular-nums">({verdictCounts.get(v) ?? 0})</span>
          </button>
        ))}
      </div>

      {/* Search + row count */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search verifications..."
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {filteredCount === filtered.length
            ? `${filtered.length} results`
            : `${filteredCount} of ${filtered.length} results`}
        </span>
      </div>

      <DataTable
        table={table}
        renderExpandedRow={(row) => {
          if (!row.getIsExpanded()) return null;
          return (
            <ExpandedVerificationDetail
              factId={row.original.factId}
              cache={detailCache}
              onLoad={fetchDetail}
            />
          );
        }}
      />

      {/* Pagination controls */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between px-1">
          <span className="text-sm text-muted-foreground">
            Showing {rangeStart}–{rangeEnd} of {filteredCount}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => table.previousPage()}
              disabled={!canPrev}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </button>
            <span className="px-2 text-xs text-muted-foreground tabular-nums">
              {currentPage} / {pageCount}
            </span>
            <button
              onClick={() => table.nextPage()}
              disabled={!canNext}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Next page"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
