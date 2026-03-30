"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { TypeRow } from "./jobs-content";

function StatusCount({
  count,
  color,
}: {
  count: number;
  color: string;
}) {
  if (count === 0) {
    return <span className="text-muted-foreground/40">0</span>;
  }
  return <span className={color}>{count}</span>;
}

function FailureRate({ rate }: { rate: number | null }) {
  if (rate === null) return <span className="text-muted-foreground/40">-</span>;
  const pct = (rate * 100).toFixed(1);
  const color =
    rate > 0.2
      ? "text-red-600"
      : rate > 0.05
        ? "text-yellow-600"
        : "text-muted-foreground";
  return <span className={color}>{pct}%</span>;
}

function AvgDuration({ ms }: { ms: number | null }) {
  if (ms === null) return <span className="text-muted-foreground/40">-</span>;
  if (ms < 1000) return <span>{Math.round(ms)}ms</span>;
  if (ms < 60_000) return <span>{(ms / 1000).toFixed(1)}s</span>;
  return <span>{(ms / 60_000).toFixed(1)}m</span>;
}

const columns: ColumnDef<TypeRow>[] = [
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
    accessorKey: "pending",
    header: ({ column }) => (
      <SortableHeader column={column}>Pending</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">
        <StatusCount count={row.original.pending} color="text-yellow-600" />
      </span>
    ),
  },
  {
    accessorKey: "running",
    header: ({ column }) => (
      <SortableHeader column={column}>Running</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">
        <StatusCount count={row.original.running} color="text-indigo-600" />
      </span>
    ),
  },
  {
    accessorKey: "completed",
    header: ({ column }) => (
      <SortableHeader column={column}>Completed</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">
        <StatusCount count={row.original.completed} color="text-emerald-600" />
      </span>
    ),
  },
  {
    accessorKey: "failed",
    header: ({ column }) => (
      <SortableHeader column={column}>Failed</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">
        <StatusCount count={row.original.failed} color="text-red-600" />
      </span>
    ),
  },
  {
    accessorKey: "total",
    header: ({ column }) => (
      <SortableHeader column={column}>Total</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums font-medium">
        {row.original.total}
      </span>
    ),
  },
  {
    accessorKey: "avgDurationMs",
    header: ({ column }) => (
      <SortableHeader column={column}>Avg Duration</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">
        <AvgDuration ms={row.original.avgDurationMs} />
      </span>
    ),
  },
  {
    accessorKey: "failureRate",
    header: ({ column }) => (
      <SortableHeader column={column}>Failure Rate</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">
        <FailureRate rate={row.original.failureRate} />
      </span>
    ),
  },
];

export function JobsOverviewTable({ data }: { data: TypeRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search job types..."
      defaultSorting={[{ id: "total", desc: true }]}
    />
  );
}
