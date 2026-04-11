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
  entityName: string;
  entityType: string;
  recordType: string;
  totalRecords: number;
  verifiedRecords: number;
  completenessPct: number;
  missingFields: string[];
  entityImportance: number | null;
  enrichmentPriority: number;
  scannedAt: string;
  href: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function completenessBadgeClass(pct: number): string {
  if (pct >= 75)
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
  if (pct >= 50)
    return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
  if (pct >= 25)
    return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
}

function priorityBadgeClass(priority: number): string {
  if (priority >= 0.5)
    return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
  if (priority >= 0.2)
    return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  if (priority >= 0.05)
    return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
  return "bg-gray-100 text-gray-600 dark:bg-gray-800/40 dark:text-gray-400";
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const columns: ColumnDef<CoverageRow>[] = [
  {
    accessorKey: "enrichmentPriority",
    header: ({ column }) => <SortableHeader column={column}>Priority</SortableHeader>,
    cell: ({ row }) => {
      const p = row.original.enrichmentPriority;
      return (
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${priorityBadgeClass(p)}`}
        >
          {p.toFixed(3)}
        </span>
      );
    },
    size: 90,
  },
  {
    accessorKey: "entityName",
    header: ({ column }) => <SortableHeader column={column}>Entity</SortableHeader>,
    cell: ({ row }) => {
      const href = row.original.href;
      return href ? (
        <a href={href} className="text-blue-600 hover:underline dark:text-blue-400">
          {row.original.entityName}
        </a>
      ) : (
        <span>{row.original.entityName}</span>
      );
    },
    size: 220,
  },
  {
    accessorKey: "recordType",
    header: ({ column }) => <SortableHeader column={column}>Record Type</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">{row.original.recordType}</span>
    ),
    size: 130,
  },
  {
    accessorKey: "entityType",
    header: ({ column }) => <SortableHeader column={column}>Entity Type</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">{row.original.entityType}</span>
    ),
    size: 110,
  },
  {
    accessorKey: "completenessPct",
    header: ({ column }) => <SortableHeader column={column}>Completeness</SortableHeader>,
    cell: ({ row }) => {
      const pct = row.original.completenessPct;
      return (
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${completenessBadgeClass(pct)}`}
        >
          {pct}%
        </span>
      );
    },
    size: 120,
  },
  {
    accessorKey: "entityImportance",
    header: ({ column }) => <SortableHeader column={column}>Importance</SortableHeader>,
    cell: ({ row }) => {
      const imp = row.original.entityImportance;
      if (imp === null) return <span className="text-xs text-muted-foreground">-</span>;
      return <span className="tabular-nums text-sm">{imp}</span>;
    },
    size: 100,
  },
  {
    accessorKey: "totalRecords",
    header: ({ column }) => <SortableHeader column={column}>Records</SortableHeader>,
    cell: ({ row }) => (
      <span className="tabular-nums text-sm">
        {row.original.totalRecords.toLocaleString()}
      </span>
    ),
    size: 90,
  },
  {
    id: "missingFields",
    header: "Missing Fields",
    cell: ({ row }) => {
      const missing = row.original.missingFields;
      if (!missing || missing.length === 0)
        return <span className="text-xs text-muted-foreground">-</span>;
      return (
        <span className="text-xs text-muted-foreground" title={missing.join(", ")}>
          {missing.length <= 3 ? missing.join(", ") : `${missing.slice(0, 3).join(", ")} +${missing.length - 3}`}
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
  recordTypes: string[];
  entityTypes: string[];
}

export function CoverageTable({ data, recordTypes, entityTypes }: CoverageTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "enrichmentPriority", desc: true },
  ]);
  const [searchQuery, setSearchQuery] = useState("");
  const [recordTypeFilter, setRecordTypeFilter] = useState<string>("all");
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    let rows = data;
    if (recordTypeFilter !== "all") {
      rows = rows.filter((r) => r.recordType === recordTypeFilter);
    }
    if (entityTypeFilter !== "all") {
      rows = rows.filter((r) => r.entityType === entityTypeFilter);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.entityName.toLowerCase().includes(q) ||
          r.entityId.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [data, recordTypeFilter, entityTypeFilter, searchQuery]);

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
            aria-label="Search entities by name"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-md border border-border bg-background pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={recordTypeFilter}
          onChange={(e) => setRecordTypeFilter(e.target.value)}
          aria-label="Filter by record type"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All record types ({data.length})</option>
          {recordTypes.map((t) => (
            <option key={t} value={t}>
              {t} ({data.filter((r) => r.recordType === t).length})
            </option>
          ))}
        </select>
        <select
          value={entityTypeFilter}
          onChange={(e) => setEntityTypeFilter(e.target.value)}
          aria-label="Filter by entity type"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All entity types</option>
          {entityTypes.map((t) => (
            <option key={t} value={t}>
              {t} ({data.filter((r) => r.entityType === t).length})
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          {filtered.length} results
        </span>
      </div>

      <DataTable table={table} />
    </div>
  );
}
