"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
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
import type { RecordRow } from "./kb-records-content";

const columns: ColumnDef<RecordRow>[] = [
  {
    accessorKey: "recordKey",
    header: ({ column }) => (
      <SortableHeader column={column}>Record Key</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/kb/record/${row.original.recordKey}`}
        className="text-primary hover:underline font-mono text-xs"
      >
        {row.original.recordKey}
      </Link>
    ),
  },
  {
    accessorKey: "entityName",
    header: ({ column }) => (
      <SortableHeader column={column}>Entity</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/kb/entity/${row.original.entityId}`}
        className="text-primary hover:underline text-sm"
      >
        {row.original.entityName}
      </Link>
    ),
  },
  {
    accessorKey: "collection",
    header: ({ column }) => (
      <SortableHeader column={column}>Collection</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-sm">{row.original.collection}</span>
    ),
  },
  {
    accessorKey: "fieldCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Fields</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-sm tabular-nums">{row.original.fieldCount}</span>
    ),
  },
  {
    id: "preview",
    header: "Preview Fields",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.previewFields.join(", ")}
      </span>
    ),
    enableSorting: false,
  },
];

export function KBRecordsTable({ data }: { data: RecordRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _columnId, filterValue) => {
      const search = filterValue.toLowerCase();
      const r = row.original;
      return (
        r.recordKey.toLowerCase().includes(search) ||
        r.entityName.toLowerCase().includes(search) ||
        r.collection.toLowerCase().includes(search) ||
        r.previewFields.some((f) => f.toLowerCase().includes(search))
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div>
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Filter records..."
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="w-full pl-9 pr-4 py-2 rounded-md border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <DataTable table={table} />
    </div>
  );
}
