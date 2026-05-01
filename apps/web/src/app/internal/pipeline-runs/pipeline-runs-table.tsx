"use client";

import {
  ServerPaginatedTable,
  type ColumnDef,
} from "@/components/server-paginated-table";
import type { PipelineRunDisplayRow } from "./pipeline-runs-content";

// ── Status Badge ─────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  running: "bg-blue-500/15 text-blue-600",
  committed: "bg-green-500/15 text-green-600",
  aborted: "bg-red-500/15 text-red-500",
  oscillation: "bg-orange-500/15 text-orange-600",
  partial_failure: "bg-yellow-500/15 text-yellow-700",
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

// ── Columns ──────────────────────────────────────────────────────────────

const columns: ColumnDef<PipelineRunDisplayRow>[] = [
  {
    id: "startedAt",
    header: "Started",
    sortField: "startedAt",
    accessor: (row) => {
      const date = new Date(row.startedAt);
      return (
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
          {date.toLocaleDateString()}{" "}
          {date.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      );
    },
  },
  {
    id: "pipelineName",
    header: "Pipeline",
    sortField: "pipelineName",
    accessor: (row) => (
      <span className="text-sm font-medium">{row.pipelineName}</span>
    ),
  },
  {
    id: "shape",
    header: "Shape",
    sortField: "shape",
    accessor: (row) =>
      row.shape ? (
        <span className="text-xs text-muted-foreground">{row.shape}</span>
      ) : (
        <span className="text-xs text-muted-foreground/50">&mdash;</span>
      ),
  },
  {
    id: "entityId",
    header: "Entity",
    sortField: "entityId",
    accessor: (row) =>
      row.entityId ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          {row.entityId}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground/50">&mdash;</span>
      ),
  },
  {
    id: "status",
    header: "Status",
    sortField: "status",
    accessor: (row) => <StatusBadge status={row.status} />,
  },
  {
    id: "durationMs",
    header: "Duration",
    sortField: "durationMs",
    align: "right" as const,
    accessor: (row) => {
      const ms = row.durationMs;
      if (ms === null) {
        return <span className="text-xs text-muted-foreground/50">&mdash;</span>;
      }
      return (
        <span className="text-xs tabular-nums">
          {ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}
        </span>
      );
    },
  },
  {
    id: "failureReason",
    header: "Failure / Error",
    accessor: (row) => {
      const text = row.failureReason ?? row.errorCode;
      if (!text) {
        return <span className="text-xs text-muted-foreground/50">&mdash;</span>;
      }
      return (
        <span
          className="text-xs text-muted-foreground max-w-[280px] block truncate"
          title={text}
        >
          {text}
        </span>
      );
    },
  },
  {
    id: "runId",
    header: "Run ID",
    accessor: (row) => (
      <span
        className="text-[10px] text-muted-foreground/70 tabular-nums max-w-[120px] block truncate"
        title={row.runId}
      >
        {row.runId.slice(0, 8)}
      </span>
    ),
  },
];

// ── Table Component ──────────────────────────────────────────────────────

export function PipelineRunsTable({ data }: { data: PipelineRunDisplayRow[] }) {
  return (
    <ServerPaginatedTable<PipelineRunDisplayRow>
      columns={columns}
      rows={data}
      rowKey={(row) => row.runId}
      defaultSortId="startedAt"
      defaultSortDir="desc"
      searchPlaceholder="Search runs..."
      itemLabel="runs"
      searchFields={[
        "pipelineName",
        "shape",
        "entityId",
        "status",
        "failureReason",
        "errorCode",
        "runId",
      ]}
      staticSort={(a, b, sortId, dir) => {
        let cmp = 0;
        if (sortId === "startedAt") {
          cmp =
            new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
        } else if (sortId === "durationMs") {
          cmp = (a.durationMs ?? -1) - (b.durationMs ?? -1);
        } else if (sortId === "pipelineName") {
          cmp = a.pipelineName.localeCompare(b.pipelineName);
        } else if (sortId === "status") {
          cmp = a.status.localeCompare(b.status);
        } else if (sortId === "shape") {
          cmp = (a.shape ?? "").localeCompare(b.shape ?? "");
        } else if (sortId === "entityId") {
          cmp = (a.entityId ?? "").localeCompare(b.entityId ?? "");
        }
        return dir === "asc" ? cmp : -cmp;
      }}
    />
  );
}
