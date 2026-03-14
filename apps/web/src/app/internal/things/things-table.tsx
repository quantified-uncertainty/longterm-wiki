"use client";

import { useState } from "react";
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

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const columns: ColumnDef<ThingRow>[] = [
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
// Component
// ---------------------------------------------------------------------------

interface ThingsTableProps {
  data: ThingRow[];
  typeFilter?: string;
}

export function ThingsTable({ data, typeFilter }: ThingsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "title", desc: false },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [selectedType, setSelectedType] = useState(typeFilter || "");

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
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

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
        Showing {table.getRowModel().rows.length} of {data.length} things
      </p>

      {/* Table */}
      <DataTable table={table} />
    </div>
  );
}
