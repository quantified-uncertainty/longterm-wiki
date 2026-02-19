"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { SourceRow } from "./page";

const columns: ColumnDef<SourceRow>[] = [
  {
    accessorKey: "enabled",
    header: ({ column }) => (
      <SortableHeader column={column}>Status</SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.enabled ? (
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-500/15 text-emerald-600">
          ON
        </span>
      ) : (
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-500/15 text-red-500">
          OFF
        </span>
      ),
    sortingFn: (rowA, rowB) => {
      return (rowA.original.enabled ? 1 : 0) - (rowB.original.enabled ? 1 : 0);
    },
  },
  {
    accessorKey: "name",
    header: ({ column }) => (
      <SortableHeader column={column}>Name</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-sm font-medium text-foreground">
        {row.original.name}
      </span>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "type",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
        {row.original.type}
      </span>
    ),
  },
  {
    accessorKey: "frequency",
    header: ({ column }) => (
      <SortableHeader column={column}>Frequency</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.frequency}
      </span>
    ),
  },
  {
    accessorKey: "reliability",
    header: ({ column }) => (
      <SortableHeader column={column}>Reliability</SortableHeader>
    ),
    cell: ({ row }) => {
      const r = row.original.reliability;
      const color =
        r === "high"
          ? "bg-emerald-500/15 text-emerald-600"
          : r === "medium"
            ? "bg-amber-500/15 text-amber-600"
            : "bg-red-500/15 text-red-500";
      return (
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${color}`}
        >
          {r}
        </span>
      );
    },
  },
  {
    accessorKey: "categories",
    header: "Categories",
    cell: ({ row }) => (
      <span className="text-[11px] text-muted-foreground">
        {row.original.categories}
      </span>
    ),
  },
  {
    accessorKey: "lastFetched",
    header: ({ column }) => (
      <SortableHeader column={column}>Last Fetched</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.lastFetched
          ? row.original.lastFetched.slice(0, 16).replace("T", " ")
          : "—"}
      </span>
    ),
  },
];

export function SourcesTable({ data }: { data: SourceRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search sources..."
      defaultSorting={[{ id: "enabled", desc: true }]}
    />
  );
}
