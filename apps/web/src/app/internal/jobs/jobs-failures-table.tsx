"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { formatAge } from "@lib/format";
import type { FailureRow } from "./jobs-content";

const columns: ColumnDef<FailureRow>[] = [
  {
    accessorKey: "id",
    header: ({ column }) => (
      <SortableHeader column={column}>ID</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.original.id}
      </span>
    ),
  },
  {
    accessorKey: "type",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.type}</span>
    ),
  },
  {
    accessorKey: "error",
    header: "Error",
    cell: ({ row }) => (
      <span
        className="text-xs text-red-600 max-w-[400px] truncate block"
        title={row.original.error}
      >
        {row.original.error}
      </span>
    ),
  },
  {
    accessorKey: "retries",
    header: ({ column }) => (
      <SortableHeader column={column}>Retries</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.retries}/{row.original.maxRetries}
      </span>
    ),
  },
  {
    accessorKey: "completedAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Failed At</SortableHeader>
    ),
    cell: ({ row }) => {
      const ts = row.original.completedAt ?? row.original.createdAt;
      return (
        <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
          {formatAge(ts)}
        </span>
      );
    },
  },
  {
    accessorKey: "workerId",
    header: "Worker",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground truncate max-w-[120px] block">
        {row.original.workerId ?? "-"}
      </span>
    ),
  },
];

export function RecentFailuresTable({ data }: { data: FailureRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search failures..."
      defaultSorting={[{ id: "completedAt", desc: true }]}
      getRowClassName={() => "bg-red-500/[0.03]"}
    />
  );
}
