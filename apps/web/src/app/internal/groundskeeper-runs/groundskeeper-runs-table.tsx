"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { GroundskeeperRunRow } from "./groundskeeper-runs-content";

// ── Event Badge ──────────────────────────────────────────────────────────

const EVENT_STYLES: Record<string, string> = {
  success: "bg-green-500/15 text-green-600",
  failure: "bg-red-500/15 text-red-500",
  error: "bg-red-500/15 text-red-500",
  circuit_breaker_tripped: "bg-red-700/15 text-red-700",
  circuit_breaker_reset: "bg-blue-500/15 text-blue-600",
  skipped: "bg-muted text-muted-foreground",
};

function EventBadge({ event }: { event: string }) {
  const style = EVENT_STYLES[event] ?? "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style}`}
    >
      {event.replace(/_/g, " ")}
    </span>
  );
}

// ── Columns ──────────────────────────────────────────────────────────────

const columns: ColumnDef<GroundskeeperRunRow>[] = [
  {
    accessorKey: "timestamp",
    header: ({ column }) => (
      <SortableHeader column={column}>Time</SortableHeader>
    ),
    cell: ({ row }) => {
      const date = new Date(row.original.timestamp);
      return (
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
          {date.toLocaleDateString()}{" "}
          {date.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
      );
    },
    sortingFn: "datetime",
  },
  {
    accessorKey: "taskName",
    header: ({ column }) => (
      <SortableHeader column={column}>Task</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-sm font-medium">{row.original.taskName}</span>
    ),
  },
  {
    accessorKey: "event",
    header: ({ column }) => (
      <SortableHeader column={column}>Event</SortableHeader>
    ),
    cell: ({ row }) => <EventBadge event={row.original.event} />,
  },
  {
    accessorKey: "durationMs",
    header: ({ column }) => (
      <SortableHeader column={column}>Duration</SortableHeader>
    ),
    cell: ({ row }) => {
      const ms = row.original.durationMs;
      if (ms === null || ms === undefined) {
        return (
          <span className="text-xs text-muted-foreground/50">—</span>
        );
      }
      return (
        <span className="text-xs tabular-nums">
          {ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}
        </span>
      );
    },
  },
  {
    accessorKey: "summary",
    header: "Summary",
    cell: ({ row }) => {
      const text = row.original.summary ?? row.original.errorMessage;
      if (!text) {
        return (
          <span className="text-xs text-muted-foreground/50">—</span>
        );
      }
      return (
        <span
          className="text-xs text-muted-foreground max-w-[300px] block truncate"
          title={text}
        >
          {text}
        </span>
      );
    },
  },
  {
    accessorKey: "consecutiveFailures",
    header: "Failures",
    cell: ({ row }) => {
      const n = row.original.consecutiveFailures;
      if (n === null || n === undefined || n === 0) {
        return (
          <span className="text-xs text-muted-foreground/50">—</span>
        );
      }
      return (
        <span
          className={`text-xs tabular-nums font-semibold ${n >= 3 ? "text-red-500" : "text-yellow-600"}`}
        >
          {n}
        </span>
      );
    },
  },
  {
    accessorKey: "circuitBreakerActive",
    header: "CB",
    cell: ({ row }) => {
      if (!row.original.circuitBreakerActive) {
        return (
          <span className="text-xs text-muted-foreground/50">—</span>
        );
      }
      return (
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-700/15 text-red-700">
          TRIPPED
        </span>
      );
    },
  },
];

// ── Table Component ──────────────────────────────────────────────────────

export function GroundskeeperRunsTable({
  data,
}: {
  data: GroundskeeperRunRow[];
}) {
  return (
    <DataTable
      columns={columns}
      data={data}
      defaultSorting={[{ id: "timestamp", desc: true }]}
      searchPlaceholder="Search runs..."
    />
  );
}
