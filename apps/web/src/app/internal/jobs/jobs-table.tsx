"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { formatAge } from "@lib/format";
import type { JobRow } from "./page";

// ── Status Badge ─────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  claimed: "bg-yellow-500/15 text-yellow-600",
  running: "bg-yellow-500/15 text-yellow-600",
  completed: "bg-emerald-500/15 text-emerald-500",
  failed: "bg-red-500/15 text-red-500",
  cancelled: "bg-muted text-muted-foreground line-through",
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style}`}
    >
      {status}
    </span>
  );
}

// ── Priority Badge ───────────────────────────────────────────────────────

function PriorityBadge({ priority }: { priority: number }) {
  if (priority === 0) {
    return <span className="text-xs text-muted-foreground/50">0</span>;
  }
  return (
    <span className="text-xs tabular-nums font-medium text-foreground">
      {priority}
    </span>
  );
}

// ── Duration Formatter ───────────────────────────────────────────────────

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// ── Expanded Row Detail ──────────────────────────────────────────────────

function JobDetail({ job }: { job: JobRow }) {
  return (
    <div className="px-4 py-3 space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-x-8 gap-y-1">
        <div>
          <span className="font-medium text-muted-foreground">Job ID:</span>{" "}
          <span className="tabular-nums">{job.id}</span>
        </div>
        <div>
          <span className="font-medium text-muted-foreground">Worker:</span>{" "}
          <span className="tabular-nums">{job.workerId ?? "—"}</span>
        </div>
        <div>
          <span className="font-medium text-muted-foreground">Retries:</span>{" "}
          <span className="tabular-nums">
            {job.retries} / {job.maxRetries}
          </span>
        </div>
        <div>
          <span className="font-medium text-muted-foreground">Created:</span>{" "}
          <span>{job.createdAt ? new Date(job.createdAt).toLocaleString() : "—"}</span>
        </div>
        {job.startedAt && (
          <div>
            <span className="font-medium text-muted-foreground">Started:</span>{" "}
            <span>{new Date(job.startedAt).toLocaleString()}</span>
          </div>
        )}
        {job.completedAt && (
          <div>
            <span className="font-medium text-muted-foreground">Completed:</span>{" "}
            <span>{new Date(job.completedAt).toLocaleString()}</span>
          </div>
        )}
      </div>
      {job.params && Object.keys(job.params).length > 0 && (
        <div>
          <span className="font-medium text-muted-foreground">Params:</span>
          <pre className="mt-1 rounded bg-muted p-2 text-[11px] overflow-x-auto">
            {JSON.stringify(job.params, null, 2)}
          </pre>
        </div>
      )}
      {job.result && Object.keys(job.result).length > 0 && (
        <div>
          <span className="font-medium text-muted-foreground">Result:</span>
          <pre className="mt-1 rounded bg-muted p-2 text-[11px] overflow-x-auto">
            {JSON.stringify(job.result, null, 2)}
          </pre>
        </div>
      )}
      {job.error && (
        <div>
          <span className="font-medium text-red-500">Error:</span>
          <pre className="mt-1 rounded bg-red-500/5 p-2 text-[11px] text-red-600 overflow-x-auto">
            {job.error}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Columns ──────────────────────────────────────────────────────────────

const columns: ColumnDef<JobRow>[] = [
  {
    accessorKey: "id",
    header: ({ column }) => (
      <SortableHeader column={column}>ID</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
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
      <span className="text-xs font-medium">{row.original.type}</span>
    ),
  },
  {
    accessorKey: "status",
    header: ({ column }) => (
      <SortableHeader column={column}>Status</SortableHeader>
    ),
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "priority",
    header: ({ column }) => (
      <SortableHeader column={column}>Pri</SortableHeader>
    ),
    cell: ({ row }) => <PriorityBadge priority={row.original.priority} />,
  },
  {
    accessorKey: "createdAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Created</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {row.original.createdAt
          ? new Date(row.original.createdAt).toLocaleDateString()
          : "—"}
        <span className="ml-1.5 text-muted-foreground/60">
          ({formatAge(row.original.createdAt)})
        </span>
      </span>
    ),
  },
  {
    accessorKey: "durationSeconds",
    header: ({ column }) => (
      <SortableHeader column={column}>Duration</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {formatDuration(row.original.durationSeconds)}
      </span>
    ),
  },
  {
    accessorKey: "retries",
    header: ({ column }) => (
      <SortableHeader column={column}>Retries</SortableHeader>
    ),
    cell: ({ row }) => {
      const { retries, maxRetries } = row.original;
      if (retries === 0) {
        return <span className="text-xs text-muted-foreground/50">0</span>;
      }
      return (
        <span
          className={`text-xs tabular-nums ${
            retries >= maxRetries ? "text-red-500 font-medium" : "text-yellow-600"
          }`}
        >
          {retries}/{maxRetries}
        </span>
      );
    },
  },
  {
    accessorKey: "error",
    header: "Error",
    cell: ({ row }) => {
      const error = row.original.error;
      if (!error) return null;
      return (
        <span
          className="text-xs text-red-500 truncate max-w-[200px] inline-block"
          title={error}
        >
          {error.length > 60 ? error.slice(0, 60) + "..." : error}
        </span>
      );
    },
  },
];

// ── Table Component ──────────────────────────────────────────────────────

export function JobsTable({ data }: { data: JobRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search jobs..."
      defaultSorting={[{ id: "id", desc: true }]}
      getRowClassName={(row) => {
        if (row.original.status === "failed") return "bg-red-500/[0.03]";
        if (row.original.status === "running" || row.original.status === "claimed")
          return "bg-yellow-500/[0.03]";
        return "";
      }}
      renderExpandedRow={(row) => <JobDetail job={row.original} />}
    />
  );
}
