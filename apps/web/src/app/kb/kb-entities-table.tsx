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
import type { EntityRow } from "./kb-entities-content";

function SourceBar({ value }: { value: number }) {
  const color =
    value >= 80
      ? "bg-emerald-500"
      : value >= 50
        ? "bg-amber-500"
        : value > 0
          ? "bg-red-400"
          : "bg-muted";

  return (
    <div className="flex items-center gap-2">
      <div className="w-12 h-2 bg-muted rounded-full overflow-hidden">
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

const columns: ColumnDef<EntityRow>[] = [
  {
    accessorKey: "entityName",
    header: ({ column }) => (
      <SortableHeader column={column}>Entity</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={row.original.entityHref}
        className="text-primary hover:underline text-xs font-medium"
      >
        {row.original.entityName}
      </Link>
    ),
    size: 180,
  },
  {
    accessorKey: "entityType",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground capitalize">
        {row.original.entityType}
      </span>
    ),
    size: 110,
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
    accessorKey: "propertyCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Properties</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums font-medium">
        {row.original.propertyCount}
      </span>
    ),
    size: 90,
  },
  {
    accessorKey: "itemCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Items</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">
        {row.original.itemCount > 0 ? row.original.itemCount : (
          <span className="text-muted-foreground/30">&mdash;</span>
        )}
      </span>
    ),
    size: 70,
  },
  {
    accessorKey: "sourceCoverage",
    header: ({ column }) => (
      <SortableHeader column={column}>Source %</SortableHeader>
    ),
    cell: ({ row }) => <SourceBar value={row.original.sourceCoverage} />,
    size: 110,
  },
  {
    accessorKey: "properties",
    header: "Properties",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground truncate block max-w-[250px]" title={row.original.properties.join(", ")}>
        {row.original.properties.join(", ")}
      </span>
    ),
    size: 250,
    enableSorting: false,
  },
];

export function KBEntitiesTable({ data }: { data: EntityRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "factCount", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const entityTypes = useMemo(() => {
    const types = new Set(data.map((r) => r.entityType));
    return [...types].sort();
  }, [data]);

  const filteredData = useMemo(() => {
    if (typeFilter === "all") return data;
    return data.filter((r) => r.entityType === typeFilter);
  }, [data, typeFilter]);

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
        r.entityName.toLowerCase().includes(search) ||
        r.entityType.toLowerCase().includes(search) ||
        r.properties.some((p) => p.toLowerCase().includes(search))
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
            placeholder="Search entities..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-9 py-2 text-sm"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="all">All types</option>
          {entityTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="text-xs text-muted-foreground">
        Showing {table.getFilteredRowModel().rows.length} of {data.length}{" "}
        entities
      </div>
      <div className="overflow-x-auto">
        <DataTable table={table} />
      </div>
    </div>
  );
}
