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
import type { FactRow } from "./kb-facts-content";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\u2026" : s;
}

const columns: ColumnDef<FactRow>[] = [
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
    size: 160,
  },
  {
    accessorKey: "propertyName",
    header: ({ column }) => (
      <SortableHeader column={column}>Property</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs">{row.original.propertyName}</span>
    ),
    size: 140,
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
    accessorKey: "displayValue",
    header: ({ column }) => (
      <SortableHeader column={column}>Value</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs font-medium tabular-nums" title={row.original.displayValue}>
        {truncate(row.original.displayValue, 60)}
      </span>
    ),
    size: 200,
  },
  {
    accessorKey: "asOf",
    header: ({ column }) => (
      <SortableHeader column={column}>As Of</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground tabular-nums">
        {row.original.asOf}
      </span>
    ),
    size: 90,
  },
  {
    accessorKey: "hasSource",
    header: ({ column }) => (
      <SortableHeader column={column}>Source</SortableHeader>
    ),
    cell: ({ row }) => {
      if (row.original.source) {
        return (
          <a
            href={row.original.source}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline"
            title={row.original.source}
          >
            Link
          </a>
        );
      }
      if (row.original.sourceResource) {
        return <span className="text-xs text-muted-foreground">{row.original.sourceResource}</span>;
      }
      return <span className="text-xs text-muted-foreground/30">&mdash;</span>;
    },
    size: 70,
  },
];

export function KBFactsTable({ data }: { data: FactRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "entityName", desc: false },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const entityTypes = useMemo(() => {
    const types = new Set(data.map((r) => r.entityType));
    return [...types].sort();
  }, [data]);

  const categories = useMemo(() => {
    const cats = new Set(data.map((r) => r.category));
    return [...cats].sort();
  }, [data]);

  const filteredData = useMemo(() => {
    let filtered = data;
    if (typeFilter !== "all") {
      filtered = filtered.filter((r) => r.entityType === typeFilter);
    }
    if (categoryFilter !== "all") {
      filtered = filtered.filter((r) => r.category === categoryFilter);
    }
    if (sourceFilter === "with-source") {
      filtered = filtered.filter((r) => r.hasSource);
    } else if (sourceFilter === "without-source") {
      filtered = filtered.filter((r) => !r.hasSource);
    }
    return filtered;
  }, [data, typeFilter, categoryFilter, sourceFilter]);

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
        r.propertyName.toLowerCase().includes(search) ||
        r.displayValue.toLowerCase().includes(search) ||
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
            placeholder="Search facts..."
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
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="all">All sources</option>
          <option value="with-source">With source</option>
          <option value="without-source">Without source</option>
        </select>
      </div>
      <div className="text-xs text-muted-foreground">
        Showing {table.getFilteredRowModel().rows.length} of {data.length} facts
      </div>
      <div className="overflow-x-auto">
        <DataTable table={table} />
      </div>
    </div>
  );
}
