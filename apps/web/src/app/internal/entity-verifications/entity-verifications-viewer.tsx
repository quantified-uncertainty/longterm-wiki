"use client";

import { useState, useEffect, useCallback } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getExpandedRowModel,
  type SortingState,
  type ExpandedState,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  Search,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Clock,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  RotateCcw,
} from "lucide-react";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────

interface VerdictRow {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sourcesChecked: number;
  needsRecheck: boolean;
  nextCheckDue: string | null;
  lastComputedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface EvidenceRow {
  id: number;
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  expectedValue: string | null;
  resourceId: string | null;
  sourceUrl: string | null;
  extractedValue: string | null;
  extractedQuote: string | null;
  verdict: string;
  confidence: number | null;
  isPrimarySource: boolean;
  checkerModel: string | null;
  notes: string | null;
  checkedAt: string | null;
}

// ── Verdict styling ─────────────────────────────────────────────────────

const VERDICT_STYLES: Record<string, { bg: string; text: string }> = {
  confirmed: { bg: "bg-emerald-500/15", text: "text-emerald-600" },
  contradicted: { bg: "bg-red-500/15", text: "text-red-600" },
  outdated: { bg: "bg-amber-500/15", text: "text-amber-600" },
  partial: { bg: "bg-amber-400/15", text: "text-amber-500" },
  unverifiable: { bg: "bg-gray-500/15", text: "text-gray-500" },
  unchecked: { bg: "bg-gray-400/15", text: "text-gray-400" },
};

function VerdictBadge({ verdict }: { verdict: string }) {
  const style = VERDICT_STYLES[verdict] || VERDICT_STYLES.unchecked;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style.bg} ${style.text}`}>
      {verdict}
    </span>
  );
}

// ── Columns ────────────────────────────────────────────────────────────────

function expandToggleColumn(): ColumnDef<VerdictRow> {
  return {
    id: "expand",
    size: 32,
    header: () => null,
    cell: ({ row }) => (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); row.toggleExpanded(); }}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label={row.getIsExpanded() ? "Collapse" : "Expand"}
      >
        <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", row.getIsExpanded() && "rotate-90")} />
      </button>
    ),
  };
}

const columns: ColumnDef<VerdictRow>[] = [
  expandToggleColumn(),
  {
    accessorKey: "recordType",
    header: ({ column }) => <SortableHeader column={column}>Type</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-xs font-medium capitalize">{row.original.recordType}</span>
    ),
  },
  {
    accessorKey: "entityId",
    header: ({ column }) => <SortableHeader column={column}>Entity</SortableHeader>,
    cell: ({ row }) => {
      const id = row.original.entityId;
      if (!id) return <span className="text-xs text-muted-foreground">-</span>;
      return (
        <span className="text-xs font-mono text-muted-foreground" title={id}>
          {id.length > 12 ? id.slice(0, 10) + "..." : id}
        </span>
      );
    },
    filterFn: "includesString",
  },
  {
    accessorKey: "recordId",
    header: ({ column }) => <SortableHeader column={column}>Record</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-xs font-mono text-muted-foreground" title={row.original.recordId}>
        {row.original.recordId.length > 15 ? row.original.recordId.slice(0, 12) + "..." : row.original.recordId}
      </span>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "verdict",
    header: ({ column }) => <SortableHeader column={column}>Verdict</SortableHeader>,
    cell: ({ row }) => <VerdictBadge verdict={row.original.verdict} />,
  },
  {
    accessorKey: "confidence",
    header: ({ column }) => <SortableHeader column={column}>Confidence</SortableHeader>,
    cell: ({ row }) => {
      const c = row.original.confidence;
      if (c == null) return <span className="text-xs text-muted-foreground">-</span>;
      return <span className="text-sm tabular-nums font-medium">{Math.round(c * 100)}%</span>;
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
    header: ({ column }) => <SortableHeader column={column}>Sources</SortableHeader>,
    cell: ({ row }) => <span className="text-sm tabular-nums">{row.original.sourcesChecked}</span>,
  },
  {
    accessorKey: "needsRecheck",
    header: ({ column }) => <SortableHeader column={column}>Recheck</SortableHeader>,
    cell: ({ row }) =>
      row.original.needsRecheck ? (
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-500/15 text-amber-500">yes</span>
      ) : (
        <span className="text-xs text-muted-foreground">no</span>
      ),
  },
  {
    accessorKey: "lastComputedAt",
    header: ({ column }) => <SortableHeader column={column}>Last Checked</SortableHeader>,
    cell: ({ row }) => {
      const d = row.original.lastComputedAt;
      if (!d) return <span className="text-xs text-muted-foreground">-</span>;
      return <span className="text-xs text-muted-foreground tabular-nums">{new Date(d).toLocaleDateString()}</span>;
    },
  },
];

// ── Expanded evidence detail ───────────────────────────────────────────────

type DetailCache = Record<string, { status: "loading" | "error" | "loaded"; data?: { evidence: EvidenceRow[] }; error?: string }>;

function ExpandedDetail({
  recordType,
  recordId,
  cache,
  onLoad,
}: {
  recordType: string;
  recordId: string;
  cache: DetailCache;
  onLoad: (recordType: string, recordId: string) => void;
}) {
  const key = `${recordType}:${recordId}`;
  const entry = cache[key];

  useEffect(() => {
    if (!entry) onLoad(recordType, recordId);
  }, [recordType, recordId, entry, onLoad]);

  if (!entry || entry.status === "loading") {
    return (
      <div className="flex items-center gap-2 px-6 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading evidence...
      </div>
    );
  }

  if (entry.status === "error") {
    return (
      <div className="flex items-center gap-3 px-6 py-4 text-sm text-red-500">
        <span>Failed: {entry.error}</span>
        <button type="button" onClick={() => onLoad(recordType, recordId)}
          className="inline-flex items-center gap-1 rounded-md border border-red-300 px-2 py-1 text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10">
          <RotateCcw className="h-3 w-3" /> Retry
        </button>
      </div>
    );
  }

  const evidence = entry.data?.evidence ?? [];
  if (evidence.length === 0) {
    return <div className="px-6 py-4 text-sm text-muted-foreground">No evidence records found.</div>;
  }

  return (
    <div className="px-6 py-4 bg-muted/30">
      <div className="text-xs font-semibold text-muted-foreground mb-2">
        Evidence ({evidence.length} source{evidence.length !== 1 ? "s" : ""})
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40 text-left text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Source</th>
              <th className="py-1.5 pr-3 font-medium">Verdict</th>
              <th className="py-1.5 pr-3 font-medium">Confidence</th>
              <th className="py-1.5 pr-3 font-medium">Expected</th>
              <th className="py-1.5 pr-3 font-medium">Found</th>
              <th className="py-1.5 pr-3 font-medium">Model</th>
              <th className="py-1.5 font-medium">Checked</th>
            </tr>
          </thead>
          <tbody>
            {evidence.map((e) => (
              <tr key={e.id} className="border-b border-border/20 last:border-0">
                <td className="py-1.5 pr-3 max-w-[200px]">
                  {e.sourceUrl ? (
                    <a href={e.sourceUrl} target="_blank" rel="noopener noreferrer"
                      className="text-blue-600 hover:underline flex items-center gap-1">
                      <ExternalLink className="h-3 w-3 shrink-0" />
                      <span className="truncate">{new URL(e.sourceUrl).hostname}</span>
                    </a>
                  ) : <span className="text-muted-foreground">-</span>}
                </td>
                <td className="py-1.5 pr-3"><VerdictBadge verdict={e.verdict} /></td>
                <td className="py-1.5 pr-3 tabular-nums">{e.confidence != null ? `${Math.round(e.confidence * 100)}%` : "-"}</td>
                <td className="py-1.5 pr-3 max-w-[150px] truncate" title={e.expectedValue ?? undefined}>
                  {e.expectedValue || "-"}
                </td>
                <td className="py-1.5 pr-3 max-w-[150px] truncate" title={e.extractedValue ?? undefined}>
                  {e.extractedValue || "-"}
                </td>
                <td className="py-1.5 pr-3 text-muted-foreground">{e.checkerModel || "-"}</td>
                <td className="py-1.5 tabular-nums text-muted-foreground">
                  {e.checkedAt ? new Date(e.checkedAt).toLocaleDateString() : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main viewer ────────────────────────────────────────────────────────────

export function EntityVerificationsViewer() {
  const [verdicts, setVerdicts] = useState<VerdictRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<DetailCache>({});

  // Filter state
  const [filterType, setFilterType] = useState("all");
  const [filterVerdict, setFilterVerdict] = useState("all");

  // Load all verdicts on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/entity-verifications-proxy?limit=200");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setVerdicts(data.verdicts ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // Compute filter options from data
  const typeCounts = new Map<string, number>();
  const verdictCounts = new Map<string, number>();
  for (const v of verdicts) {
    typeCounts.set(v.recordType, (typeCounts.get(v.recordType) ?? 0) + 1);
    verdictCounts.set(v.verdict, (verdictCounts.get(v.verdict) ?? 0) + 1);
  }

  const filtered = verdicts.filter((v) => {
    if (filterType !== "all" && v.recordType !== filterType) return false;
    if (filterVerdict !== "all" && v.verdict !== filterVerdict) return false;
    return true;
  });

  // Table state
  const [sorting, setSorting] = useState<SortingState>([{ id: "lastComputedAt", desc: true }]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 100 });

  useEffect(() => {
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }, [globalFilter, filterType, filterVerdict]);

  const table = useReactTable({
    data: filtered,
    columns,
    getRowId: (row) => `${row.recordType}:${row.recordId}:${row.fieldName ?? ""}`,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onExpandedChange: setExpanded,
    onPaginationChange: setPagination,
    globalFilterFn: "includesString",
    state: { sorting, globalFilter, expanded, pagination },
  });

  const fetchDetail = useCallback(async (recordType: string, recordId: string) => {
    const key = `${recordType}:${recordId}`;
    setDetailCache((prev) => ({ ...prev, [key]: { status: "loading" } }));
    try {
      const res = await fetch(`/api/verification-detail?recordType=${encodeURIComponent(recordType)}&recordId=${encodeURIComponent(recordId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setDetailCache((prev) => ({ ...prev, [key]: { status: "loaded", data: json } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[entity-verifications] Failed to load evidence for ${key}: ${msg}`);
      setDetailCache((prev) => ({ ...prev, [key]: { status: "error", error: msg } }));
    }
  }, []);

  const filteredCount = table.getFilteredRowModel().rows.length;
  const pageCount = table.getPageCount();
  const currentPage = table.getState().pagination.pageIndex + 1;
  const { pageIndex, pageSize: ps } = table.getState().pagination;
  const rangeStart = pageIndex * ps + 1;
  const rangeEnd = Math.min((pageIndex + 1) * ps, filteredCount);

  // Stats
  const avgConfidence = verdicts.length > 0
    ? verdicts.reduce((s, v) => s + (v.confidence ?? 0), 0) / verdicts.length : 0;
  const needsRecheck = verdicts.filter((v) => v.needsRecheck).length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading verifications...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600">
        Failed to load verifications: {error}
      </div>
    );
  }

  return (
    <div className="not-prose">
      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Total Verdicts</p>
          <p className="text-2xl font-bold tabular-nums">{verdicts.length}</p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Avg Confidence</p>
          <p className="text-2xl font-bold tabular-nums">{avgConfidence > 0 ? `${Math.round(avgConfidence * 100)}%` : "N/A"}</p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Needs Recheck</p>
          <p className={cn("text-2xl font-bold tabular-nums", needsRecheck > 0 ? "text-amber-600" : "")}>{needsRecheck}</p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Record Types</p>
          <p className="text-2xl font-bold tabular-nums">{typeCounts.size}</p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="space-y-3 mb-4">
        <div className="flex gap-1.5 flex-wrap">
          <button onClick={() => setFilterType("all")}
            className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              filterType === "all" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
            All types ({verdicts.length})
          </button>
          {[...typeCounts.entries()].sort(([, a], [, b]) => b - a).map(([type, count]) => (
            <button key={type} onClick={() => setFilterType(type)}
              className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                filterType === type ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
              {type} ({count})
            </button>
          ))}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <button onClick={() => setFilterVerdict("all")}
            className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              filterVerdict === "all" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/80")}>
            All verdicts
          </button>
          {[...verdictCounts.entries()].sort(([, a], [, b]) => b - a).map(([v, count]) => {
            const style = VERDICT_STYLES[v] || VERDICT_STYLES.unchecked;
            return (
              <button key={v} onClick={() => setFilterVerdict(v)}
                className={cn("px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                  filterVerdict === v ? `${style.bg} ${style.text}` : "bg-muted text-muted-foreground hover:bg-muted/80")}>
                {v} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* Search + count */}
      <div className="flex items-center gap-4 mb-4">
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

      {/* Table */}
      <DataTable
        table={table}
        renderExpandedRow={(row) => {
          if (!row.getIsExpanded()) return null;
          return (
            <ExpandedDetail
              recordType={row.original.recordType}
              recordId={row.original.recordId}
              cache={detailCache}
              onLoad={fetchDetail}
            />
          );
        }}
      />

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between px-1 mt-4">
          <span className="text-sm text-muted-foreground">
            Showing {rangeStart}–{rangeEnd} of {filteredCount}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </button>
            <span className="px-2 text-xs text-muted-foreground tabular-nums">{currentPage} / {pageCount}</span>
            <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-4">
        Data from <code className="text-[11px]">verification_verdicts</code> table.
        Click a row to expand and see per-source evidence.
      </p>
    </div>
  );
}
