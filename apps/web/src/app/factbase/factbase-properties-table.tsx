"use client";

import { useState, useMemo } from "react";
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
import Link from "next/link";
import { Search } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import type { PropertyRow } from "./factbase-properties-content";

function CoverageBar({ value }: { value: number }) {
  const color =
    value >= 50
      ? "bg-emerald-500"
      : value >= 20
        ? "bg-amber-500"
        : value > 0
          ? "bg-red-400"
          : "bg-muted";

  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">
        {value}%
      </span>
    </div>
  );
}

const columns: ColumnDef<PropertyRow>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => (
      <SortableHeader column={column}>Property</SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <Link
          href={`/factbase/property/${row.original.id}`}
          className="text-xs font-medium text-primary hover:underline"
        >
          {row.original.name}
        </Link>
        <div className="text-xs text-muted-foreground truncate max-w-[250px]">
          {row.original.description}
        </div>
      </div>
    ),
    size: 260,
  },
  {
    accessorKey: "dataType",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.dataType}
        {row.original.unit ? ` (${row.original.unit})` : ""}
      </span>
    ),
    size: 100,
  },
  {
    accessorKey: "category",
    header: ({ column }) => (
      <SortableHeader column={column}>Category</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs capitalize text-muted-foreground">
        {row.original.category}
      </span>
    ),
    size: 100,
  },
  {
    accessorKey: "factCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Facts</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums font-medium">
        {row.original.factCount}
      </span>
    ),
    size: 70,
  },
  {
    accessorKey: "entityCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Entities</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums font-medium">
        {row.original.entityCount}
      </span>
    ),
    size: 80,
  },
  {
    accessorKey: "coverage",
    header: ({ column }) => (
      <SortableHeader column={column}>Coverage</SortableHeader>
    ),
    cell: ({ row }) => <CoverageBar value={row.original.coverage} />,
    size: 120,
  },
  {
    accessorKey: "temporal",
    header: ({ column }) => (
      <SortableHeader column={column}>Temporal</SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.temporal ? (
        <span className="text-emerald-500 text-xs font-bold">Yes</span>
      ) : (
        <span className="text-muted-foreground/30 text-xs">No</span>
      ),
    size: 70,
  },
  {
    accessorKey: "appliesTo",
    header: "Applies To",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.appliesTo.join(", ") || "all"}
      </span>
    ),
    size: 140,
  },
];

export function FBPropertiesTable({ data }: { data: PropertyRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "factCount", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [usageFilter, setUsageFilter] = useState<string>("all");

  const categories = useMemo(() => {
    const cats = new Set(data.map((r) => r.category));
    return [...cats].sort();
  }, [data]);

  const filteredData = useMemo(() => {
    let filtered = data;
    if (categoryFilter !== "all") {
      filtered = filtered.filter((r) => r.category === categoryFilter);
    }
    if (usageFilter === "in-use") {
      filtered = filtered.filter((r) => r.factCount > 0);
    } else if (usageFilter === "unused") {
      filtered = filtered.filter((r) => r.factCount === 0);
    }
    return filtered;
  }, [data, categoryFilter, usageFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _columnId, filterValue) => {
      const search = filterValue.toLowerCase();
      const r = row.original;
      return (
        r.name.toLowerCase().includes(search) ||
        r.description.toLowerCase().includes(search) ||
        r.id.toLowerCase().includes(search) ||
        r.category.toLowerCase().includes(search)
      );
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search properties..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-9 py-2 text-sm"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={usageFilter}
          onChange={(e) => setUsageFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="all">All usage</option>
          <option value="in-use">In use</option>
          <option value="unused">Unused</option>
        </select>
      </div>
      <div className="text-xs text-muted-foreground">
        Showing {table.getFilteredRowModel().rows.length} of {data.length}{" "}
        properties
      </div>
      <div className="overflow-x-auto">
        <DataTable table={table} />
      </div>
    </div>
  );
}
