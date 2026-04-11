"use client";

import { useState, useMemo } from "react";
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoverageRow {
  entityId: string;
  entityType: string;
  title: string;
  coverageScore: number;
  signalsFilled: number;
  signalsTotal: number;
  signals: Record<string, boolean>;
  scannedAt: string;
  href: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreBadgeClass(score: number): string {
  switch (score) {
    case 1:
      return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
    case 2:
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    case 3:
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
    case 4:
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
    default:
      return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300";
  }
}

function scoreLabel(score: number): string {
  switch (score) {
    case 1:
      return "Stub";
    case 2:
      return "Basic";
    case 3:
      return "Moderate";
    case 4:
      return "Comprehensive";
    default:
      return "Unknown";
  }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const columns: ColumnDef<CoverageRow>[] = [
  {
    accessorKey: "title",
    header: ({ column }) => <SortableHeader column={column}>Entity</SortableHeader>,
    cell: ({ row }) => {
      const href = row.original.href;
      return href ? (
        <a href={href} className="text-blue-600 hover:underline dark:text-blue-400">
          {row.original.title}
        </a>
      ) : (
        <span>{row.original.title}</span>
      );
    },
    size: 280,
  },
  {
    accessorKey: "entityType",
    header: ({ column }) => <SortableHeader column={column}>Type</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">{row.original.entityType}</span>
    ),
    size: 120,
  },
  {
    accessorKey: "coverageScore",
    header: ({ column }) => <SortableHeader column={column}>Score</SortableHeader>,
    cell: ({ row }) => {
      const score = row.original.coverageScore;
      return (
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${scoreBadgeClass(score)}`}>
          {score} - {scoreLabel(score)}
        </span>
      );
    },
    size: 140,
  },
  {
    accessorKey: "signalsFilled",
    header: ({ column }) => <SortableHeader column={column}>Signals</SortableHeader>,
    cell: ({ row }) => (
      <span className="tabular-nums text-sm">
        {row.original.signalsFilled}/{row.original.signalsTotal}
      </span>
    ),
    size: 90,
  },
  {
    id: "missingSignals",
    header: "Missing",
    cell: ({ row }) => {
      const missing = Object.entries(row.original.signals)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      if (missing.length === 0) return <span className="text-xs text-muted-foreground">-</span>;
      return (
        <span className="text-xs text-muted-foreground">
          {missing.join(", ")}
        </span>
      );
    },
    size: 200,
  },
  {
    accessorKey: "scannedAt",
    header: ({ column }) => <SortableHeader column={column}>Scanned</SortableHeader>,
    cell: ({ row }) => {
      const d = new Date(row.original.scannedAt);
      return (
        <span className="text-xs text-muted-foreground tabular-nums">
          {d.toLocaleDateString()}
        </span>
      );
    },
    size: 100,
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CoverageTableProps {
  data: CoverageRow[];
  entityTypes: string[];
}

export function CoverageTable({ data, entityTypes }: CoverageTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "coverageScore", desc: false },
  ]);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    let rows = data;
    if (typeFilter !== "all") {
      rows = rows.filter((r) => r.entityType === typeFilter);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.entityId.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [data, typeFilter, searchQuery]);

  const table = useReactTable({
    data: filtered,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search entities..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-md border border-border bg-background pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All types ({data.length})</option>
          {entityTypes.map((t) => (
            <option key={t} value={t}>
              {t} ({data.filter((r) => r.entityType === t).length})
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {filtered.length} entities
        </span>
      </div>

      <DataTable table={table} />
    </div>
  );
}
