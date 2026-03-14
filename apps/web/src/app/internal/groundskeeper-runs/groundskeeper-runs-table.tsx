"use client";

import {
  ServerPaginatedTable,
  type ColumnDef,
} from "@/components/server-paginated-table";
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
    id: "timestamp",
    header: "Time",
    sortField: "timestamp",
    accessor: (row) => {
      const date = new Date(row.timestamp);
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
  },
  {
    id: "taskName",
    header: "Task",
    sortField: "taskName",
    accessor: (row) => (
      <span className="text-sm font-medium">{row.taskName}</span>
    ),
  },
  {
    id: "event",
    header: "Event",
    sortField: "event",
    accessor: (row) => <EventBadge event={row.event} />,
  },
  {
    id: "durationMs",
    header: "Duration",
    sortField: "durationMs",
    align: "right" as const,
    accessor: (row) => {
      const ms = row.durationMs;
      if (ms === null || ms === undefined) {
        return (
          <span className="text-xs text-muted-foreground/50">&mdash;</span>
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
    id: "summary",
    header: "Summary",
    accessor: (row) => {
      const text = row.summary ?? row.errorMessage;
      if (!text) {
        return (
          <span className="text-xs text-muted-foreground/50">&mdash;</span>
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
    id: "consecutiveFailures",
    header: "Failures",
    sortField: "consecutiveFailures",
    align: "right" as const,
    accessor: (row) => {
      const n = row.consecutiveFailures;
      if (n === null || n === undefined || n === 0) {
        return (
          <span className="text-xs text-muted-foreground/50">&mdash;</span>
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
    id: "circuitBreakerActive",
    header: "CB",
    accessor: (row) => {
      if (!row.circuitBreakerActive) {
        return (
          <span className="text-xs text-muted-foreground/50">&mdash;</span>
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
    <ServerPaginatedTable<GroundskeeperRunRow>
      columns={columns}
      rows={data}
      rowKey={(row) => String(row.id)}
      defaultSortId="timestamp"
      defaultSortDir="desc"
      searchPlaceholder="Search runs..."
      itemLabel="runs"
      searchFields={["taskName", "event", "summary", "errorMessage"]}
      staticSort={(a, b, sortId, dir) => {
        let cmp = 0;
        if (sortId === "timestamp") {
          cmp = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
        } else if (sortId === "durationMs") {
          cmp = (a.durationMs ?? -1) - (b.durationMs ?? -1);
        } else if (sortId === "consecutiveFailures") {
          cmp = (a.consecutiveFailures ?? 0) - (b.consecutiveFailures ?? 0);
        } else if (sortId === "taskName") {
          cmp = a.taskName.localeCompare(b.taskName);
        } else if (sortId === "event") {
          cmp = a.event.localeCompare(b.event);
        }
        return dir === "asc" ? cmp : -cmp;
      }}
    />
  );
}
