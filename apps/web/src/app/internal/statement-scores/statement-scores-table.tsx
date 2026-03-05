"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type {
  ColumnDef,
  SortingState,
} from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import type { CoverageScoreRow } from "@/app/internal/statement-scores/statement-scores-content";

// ── Helpers ───────────────────────────────────────────────────────────────

function QualityBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    value >= 0.8
      ? "bg-green-500"
      : value >= 0.6
        ? "bg-emerald-400"
        : value >= 0.4
          ? "bg-yellow-400"
          : value >= 0.2
            ? "bg-orange-400"
            : "bg-red-400";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-2 bg-muted/40 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-muted-foreground w-8 text-right">
        {pct}%
      </span>
    </div>
  );
}

function CategoryBadges({ scores }: { scores: Record<string, number> }) {
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return <span className="text-muted-foreground text-xs">--</span>;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {entries.slice(0, 4).map(([cat, score]) => {
        const pct = Math.round(score * 100);
        const bgColor =
          score >= 0.7
            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
            : score >= 0.4
              ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300"
              : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
        return (
          <span
            key={cat}
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${bgColor}`}
            title={`${cat}: ${pct}%`}
          >
            {cat.slice(0, 8)} {pct}%
          </span>
        );
      })}
      {entries.length > 4 && (
        <span className="text-[10px] text-muted-foreground">
          +{entries.length - 4}
        </span>
      )}
    </div>
  );
}

// ── Table Component ───────────────────────────────────────────────────────

interface StatementScoresTableProps {
  data: CoverageScoreRow[];
}

export function StatementScoresTable({ data }: StatementScoresTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "coverageScore", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");

  const columns: ColumnDef<CoverageScoreRow>[] = useMemo(
    () => [
      {
        accessorKey: "entityId",
        header: ({ column }) => (
          <SortableHeader column={column}>Entity</SortableHeader>
        ),
        cell: ({ row }) => {
          const entityId = row.original.entityId;
          return (
            <Link
              href={`/wiki/${entityId}`}
              className="text-blue-600 hover:underline text-xs font-medium"
            >
              {entityId}
            </Link>
          );
        },
        size: 140,
      },
      {
        accessorKey: "coverageScore",
        header: ({ column }) => (
          <SortableHeader column={column}>Coverage</SortableHeader>
        ),
        cell: ({ row }) => <QualityBar value={row.original.coverageScore} />,
        size: 120,
      },
      {
        accessorKey: "qualityAvg",
        header: ({ column }) => (
          <SortableHeader column={column}>Avg Quality</SortableHeader>
        ),
        cell: ({ row }) => {
          const val = row.original.qualityAvg;
          if (val == null) {
            return <span className="text-muted-foreground text-xs">--</span>;
          }
          return <QualityBar value={val} />;
        },
        size: 120,
      },
      {
        accessorKey: "statementCount",
        header: ({ column }) => (
          <SortableHeader column={column}>Statements</SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="text-xs tabular-nums font-medium">
            {row.original.statementCount}
          </span>
        ),
        size: 90,
      },
      {
        id: "categoryScores",
        header: "Categories",
        cell: ({ row }) => (
          <CategoryBadges
            scores={row.original.categoryScores as Record<string, number>}
          />
        ),
        size: 250,
      },
      {
        accessorKey: "scoredAt",
        header: ({ column }) => (
          <SortableHeader column={column}>Scored At</SortableHeader>
        ),
        cell: ({ row }) => {
          const date = row.original.scoredAt;
          if (!date) return <span className="text-muted-foreground text-xs">--</span>;
          const d = new Date(date);
          return (
            <span className="text-xs tabular-nums text-muted-foreground">
              {d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
          );
        },
        size: 90,
      },
    ],
    []
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search entities..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {table.getFilteredRowModel().rows.length} of {data.length} entities
        </span>
      </div>

      <DataTable table={table} />
    </div>
  );
}
