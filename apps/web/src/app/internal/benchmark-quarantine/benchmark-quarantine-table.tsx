"use client";

import { useMemo, useState } from "react";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import type { RpcBenchmarkResultsPendingRow } from "@lib/wiki-server";

// ── Types ─────────────────────────────────────────────────────────────────

export type BenchmarkQuarantineRow = RpcBenchmarkResultsPendingRow & {
  /** Resolved benchmark display name (set by server component) */
  benchmarkName: string;
  /** Benchmark slug for /benchmarks/<slug> link, null when unresolved */
  benchmarkSlug: string | null;
};

type StatusFilter = "all" | "pending" | "resolved" | "rejected";

// ── Formatting ────────────────────────────────────────────────────────────

function formatScore(
  score: number | null,
  scoreText: string | null,
  unit: string | null,
): string {
  if (scoreText) return scoreText;
  if (score == null) return "—";
  const formatted =
    Math.abs(score) >= 100 ? score.toFixed(0) : score.toFixed(2);
  return unit ? `${formatted} ${unit}` : formatted;
}

function formatDate(value: string | Date | null): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function statusColor(status: string): string {
  switch (status) {
    case "pending":
      return "text-amber-600";
    case "resolved":
      return "text-emerald-600";
    case "rejected":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
}

// ── Columns ───────────────────────────────────────────────────────────────

const columns: ColumnDef<BenchmarkQuarantineRow>[] = [
  {
    accessorKey: "status",
    header: ({ column }) => (
      <SortableHeader column={column} title="Status">
        Status
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span
        className={`text-xs font-medium capitalize ${statusColor(row.original.status)}`}
      >
        {row.original.status}
      </span>
    ),
    size: 80,
  },
  {
    accessorKey: "rawModelName",
    header: ({ column }) => (
      <SortableHeader column={column} title="Raw model name from ingester">
        Raw model
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span
        className="text-sm font-mono max-w-[260px] truncate block"
        title={row.original.rawModelName}
      >
        {row.original.rawModelName}
      </span>
    ),
    filterFn: "includesString",
    size: 260,
  },
  {
    id: "benchmark",
    accessorFn: (r) => r.benchmarkName,
    header: ({ column }) => (
      <SortableHeader column={column} title="Benchmark">
        Benchmark
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const slug = row.original.benchmarkSlug;
      const name = row.original.benchmarkName;
      return slug ? (
        <a
          href={`/benchmarks/${slug}`}
          className="text-sm text-accent-foreground hover:underline"
        >
          {name}
        </a>
      ) : (
        <span className="text-sm text-muted-foreground" title={row.original.benchmarkId}>
          {name}
        </span>
      );
    },
    size: 160,
  },
  {
    id: "score",
    accessorFn: (r) => r.score,
    header: ({ column }) => (
      <SortableHeader column={column} title="Reported score">
        Score
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">
        {formatScore(
          row.original.score,
          row.original.scoreText,
          row.original.unit,
        )}
      </span>
    ),
    size: 100,
    sortUndefined: "last",
  },
  {
    accessorKey: "ingesterSource",
    header: ({ column }) => (
      <SortableHeader column={column} title="Ingester that produced this row">
        Source
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs font-mono text-muted-foreground">
        {row.original.ingesterSource}
      </span>
    ),
    size: 140,
  },
  {
    accessorKey: "evaluationDate",
    header: ({ column }) => (
      <SortableHeader column={column} title="Evaluation date">
        Eval date
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.evaluationDate ?? "—"}
      </span>
    ),
    size: 100,
  },
  {
    accessorKey: "createdAt",
    header: ({ column }) => (
      <SortableHeader column={column} title="When the row was ingested">
        Ingested
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {formatDate(row.original.createdAt)}
      </span>
    ),
    size: 100,
  },
  {
    id: "sourceUrl",
    accessorFn: (r) => r.sourceUrl,
    header: () => <span className="text-xs">Source URL</span>,
    enableSorting: false,
    cell: ({ row }) => {
      const url = row.original.sourceUrl;
      if (!url) return <span className="text-xs text-muted-foreground/50">—</span>;
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent-foreground hover:underline truncate max-w-[240px] block"
          title={url}
        >
          {url.replace(/^https?:\/\//, "")}
        </a>
      );
    },
    size: 240,
  },
  {
    id: "resolution",
    accessorFn: (r) => r.resolvedToStableId ?? r.rejectedReason ?? "",
    header: () => <span className="text-xs">Resolution</span>,
    enableSorting: false,
    cell: ({ row }) => {
      const r = row.original;
      if (r.status === "resolved" && r.resolvedToStableId) {
        return (
          <span
            className="text-xs font-mono text-emerald-600 truncate max-w-[180px] block"
            title={`Resolved → ${r.resolvedToStableId}${r.resolvedBy ? ` by ${r.resolvedBy}` : ""}`}
          >
            → {r.resolvedToStableId}
          </span>
        );
      }
      if (r.status === "rejected" && r.rejectedReason) {
        return (
          <span
            className="text-xs text-muted-foreground italic truncate max-w-[180px] block"
            title={r.rejectedReason}
          >
            {r.rejectedReason}
          </span>
        );
      }
      return <span className="text-xs text-muted-foreground/50">—</span>;
    },
    size: 180,
  },
];

// ── Table component ───────────────────────────────────────────────────────

export function BenchmarkQuarantineTable({
  data,
}: {
  data: BenchmarkQuarantineRow[];
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const r of data) set.add(r.ingesterSource);
    return Array.from(set).sort();
  }, [data]);

  // Status counts for the filter buttons (computed on the unfiltered set so
  // the labels are stable while the user toggles between views).
  const statusCounts = useMemo(() => {
    const c = { pending: 0, resolved: 0, rejected: 0, all: data.length };
    for (const r of data) {
      if (r.status === "pending") c.pending++;
      else if (r.status === "resolved") c.resolved++;
      else if (r.status === "rejected") c.rejected++;
    }
    return c;
  }, [data]);

  const filteredData = useMemo(() => {
    return data.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (sourceFilter !== "all" && r.ingesterSource !== sourceFilter)
        return false;
      return true;
    });
  }, [data, statusFilter, sourceFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    state: { sorting, globalFilter },
  });

  const visibleCount = table.getFilteredRowModel().rows.length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        {/* Status filter buttons */}
        <div className="flex items-center gap-1 rounded-lg border border-border/60 p-1">
          {(["pending", "resolved", "rejected", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`text-xs px-2.5 py-1 rounded capitalize transition-colors ${
                statusFilter === s
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {s} <span className="tabular-nums opacity-70">({statusCounts[s]})</span>
            </button>
          ))}
        </div>

        {/* Source filter */}
        {sources.length > 1 && (
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="h-9 rounded-lg border border-border bg-background px-3 text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}

        {/* Free-text search */}
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Filter by raw model name, benchmark, source..."
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>

        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {visibleCount === filteredData.length
            ? `${filteredData.length} rows`
            : `${visibleCount} of ${filteredData.length} rows`}
        </span>
      </div>

      <DataTable table={table} />
    </div>
  );
}
