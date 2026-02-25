"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { formatAge } from "@lib/format";
import type { ResourceBreakdownRow } from "./page";

const columns: ColumnDef<ResourceBreakdownRow>[] = [
  {
    accessorKey: "resourceId",
    header: ({ column }) => (
      <SortableHeader column={column}>Resource ID</SortableHeader>
    ),
    cell: ({ row }) => (
      <span
        className="text-xs font-mono truncate max-w-[200px] inline-block"
        title={row.original.resourceId}
      >
        {row.original.resourceId}
      </span>
    ),
  },
  {
    accessorKey: "claimCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Claims</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs font-mono font-semibold">
        {row.original.claimCount}
      </span>
    ),
  },
  {
    accessorKey: "entityCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Entities</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs font-mono">{row.original.entityCount}</span>
    ),
  },
  {
    accessorKey: "latestDate",
    header: ({ column }) => (
      <SortableHeader column={column}>Latest</SortableHeader>
    ),
    cell: ({ row }) => (
      <span
        className="text-xs whitespace-nowrap"
        title={row.original.latestDate}
      >
        {row.original.latestDate ? formatAge(row.original.latestDate) : "-"}
      </span>
    ),
  },
];

export function IngestionTable({ data }: { data: ResourceBreakdownRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      defaultSorting={[{ id: "claimCount", desc: true }]}
    />
  );
}
