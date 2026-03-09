"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { ColumnDef, SortingState, ExpandedState } from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getExpandedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search, ChevronRight, ChevronDown } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";

export interface PropertyRow {
  id: string;
  name: string;
  description: string;
  category: string;
  dataType: string;
  unit: string | null;
  temporal: boolean;
  computed: boolean;
  factCount: number;
  entityCount: number;
  applicableCount: number;
  coverage: number;
  appliesTo: string[];
  entityData: {
    entityId: string;
    entityName: string;
    latestValue: string;
    asOf: string | null;
    source: string | null;
    allValuesCount: number;
  }[];
}

// ---------------------------------------------------------------------------
// Coverage bar
// ---------------------------------------------------------------------------

function CoverageBar({ value, entityCount, applicableCount }: { value: number; entityCount: number; applicableCount: number }) {
  const pct = Math.round(value * 100);
  const color =
    pct >= 75
      ? "bg-emerald-500"
      : pct >= 50
        ? "bg-amber-500"
        : pct >= 25
          ? "bg-orange-500"
          : pct > 0
            ? "bg-red-400"
            : "bg-slate-300";

  return (
    <div className="flex items-center gap-2" title={`${entityCount} of ${applicableCount} applicable entities (${pct}%)`}>
      <div className="h-2 w-16 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data type badge
// ---------------------------------------------------------------------------

const dataTypeColors: Record<string, string> = {
  number: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  text: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  date: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  ref: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  refs: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  boolean: "bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300",
};

function DataTypeBadge({ type }: { type: string }) {
  const color = dataTypeColors[type] ?? "bg-slate-100 text-slate-600";
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium ${color}`}>
      {type}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Expanded row: entity detail sub-table
// ---------------------------------------------------------------------------

function EntityDetailTable({ data }: { data: PropertyRow["entityData"]; }) {
  if (data.length === 0) {
    return (
      <div className="py-4 px-6 text-sm text-muted-foreground">
        No entities have data for this property.
      </div>
    );
  }

  return (
    <div className="bg-muted/30 border-t border-border/40">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground border-b border-border/30">
            <th className="py-2 px-4 font-medium">Entity</th>
            <th className="py-2 px-4 font-medium">Latest Value</th>
            <th className="py-2 px-4 font-medium">As Of</th>
            <th className="py-2 px-4 font-medium">Source</th>
            <th className="py-2 px-4 font-medium text-right">Values</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.entityId} className="border-b border-border/20 hover:bg-muted/40">
              <td className="py-1.5 px-4">
                <Link
                  href={`/wiki/${d.entityId}`}
                  className="text-primary hover:underline text-xs font-medium"
                >
                  {d.entityName}
                </Link>
              </td>
              <td className="py-1.5 px-4 text-xs tabular-nums max-w-[200px] truncate" title={d.latestValue}>
                {d.latestValue}
              </td>
              <td className="py-1.5 px-4 text-xs text-muted-foreground tabular-nums">
                {d.asOf ?? "-"}
              </td>
              <td className="py-1.5 px-4 text-xs max-w-[200px] truncate">
                {d.source ? (
                  <a
                    href={d.source}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary/70 hover:underline"
                    title={d.source}
                  >
                    link
                  </a>
                ) : (
                  <span className="text-muted-foreground/40">-</span>
                )}
              </td>
              <td className="py-1.5 px-4 text-xs tabular-nums text-right text-muted-foreground">
                {d.allValuesCount}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const columns: ColumnDef<PropertyRow>[] = [
  {
    id: "expand",
    size: 32,
    header: () => null,
    cell: ({ row }) => (
      <button
        type="button"
        onClick={() => row.toggleExpanded()}
        className="p-0.5 rounded hover:bg-muted/60 transition-colors"
        aria-label={row.getIsExpanded() ? "Collapse" : "Expand"}
      >
        {row.getIsExpanded() ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>
    ),
  },
  {
    accessorKey: "name",
    size: 180,
    header: ({ column }) => (
      <SortableHeader column={column} title="Property display name">
        Name
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <span className="text-sm font-medium">{row.original.name}</span>
        {row.original.computed && (
          <span className="ml-1.5 text-[10px] text-muted-foreground bg-muted px-1 py-0.5 rounded">
            computed
          </span>
        )}
        {row.original.description && (
          <p className="text-[11px] text-muted-foreground leading-tight mt-0.5 line-clamp-1">
            {row.original.description}
          </p>
        )}
      </div>
    ),
  },
  {
    accessorKey: "category",
    size: 100,
    header: ({ column }) => (
      <SortableHeader column={column} title="Property category">
        Category
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground capitalize">
        {row.original.category}
      </span>
    ),
  },
  {
    accessorKey: "dataType",
    size: 80,
    header: ({ column }) => (
      <SortableHeader column={column} title="Data type">
        Type
      </SortableHeader>
    ),
    cell: ({ row }) => <DataTypeBadge type={row.original.dataType} />,
  },
  {
    accessorKey: "unit",
    size: 80,
    header: ({ column }) => (
      <SortableHeader column={column} title="Unit of measurement">
        Unit
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.unit ?? "-"}
      </span>
    ),
  },
  {
    accessorKey: "factCount",
    size: 70,
    header: ({ column }) => (
      <SortableHeader column={column} title="Total number of facts across all entities">
        Facts
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span
        className={`text-xs tabular-nums font-medium ${
          row.original.factCount > 0 ? "text-foreground" : "text-muted-foreground/40"
        }`}
      >
        {row.original.factCount}
      </span>
    ),
  },
  {
    accessorKey: "entityCount",
    size: 80,
    header: ({ column }) => (
      <SortableHeader column={column} title="Number of entities with data for this property">
        Entities
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span
        className={`text-xs tabular-nums font-medium ${
          row.original.entityCount > 0 ? "text-foreground" : "text-muted-foreground/40"
        }`}
      >
        {row.original.entityCount}
      </span>
    ),
  },
  {
    accessorKey: "temporal",
    size: 70,
    header: ({ column }) => (
      <SortableHeader column={column} title="Whether this property changes over time">
        Temporal
      </SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.temporal ? (
        <span className="text-emerald-500 text-xs font-bold" title="Temporal property">
          Yes
        </span>
      ) : (
        <span className="text-muted-foreground/30 text-xs">No</span>
      ),
  },
  {
    accessorKey: "coverage",
    size: 130,
    header: ({ column }) => (
      <SortableHeader column={column} title="% of applicable entities with at least one fact">
        Coverage
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <CoverageBar
        value={row.original.coverage}
        entityCount={row.original.entityCount}
        applicableCount={row.original.applicableCount}
      />
    ),
  },
];

// ---------------------------------------------------------------------------
// Main table component
// ---------------------------------------------------------------------------

export function PropertyExplorerTable({ data }: { data: PropertyRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "factCount", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<ExpandedState>({});

  // Unique categories for the dropdown
  const categories = useMemo(() => {
    const cats = new Set(data.map((d) => d.category));
    return ["all", ...Array.from(cats).sort()];
  }, [data]);

  // Filter by category
  const filteredData = useMemo(() => {
    if (categoryFilter === "all") return data;
    return data.filter((d) => d.category === categoryFilter);
  }, [data, categoryFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, globalFilter, expanded },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onExpandedChange: setExpanded,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    globalFilterFn: "includesString",
    getRowCanExpand: () => true,
  });

  const filteredCount = table.getFilteredRowModel().rows.length;

  return (
    <div className="space-y-4">
      {/* Search + category filter */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search properties..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="h-10 rounded-lg border border-border bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
        >
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {cat === "all" ? "All categories" : cat}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {filteredCount === data.length
            ? `${data.length} properties`
            : `${filteredCount} of ${data.length} properties`}
        </span>
      </div>

      {/* Table with expandable rows */}
      <DataTable
        table={table}
        renderExpandedRow={(row) =>
          row.getIsExpanded() ? (
            <EntityDetailTable data={row.original.entityData} />
          ) : null
        }
      />
    </div>
  );
}
