"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { GITHUB_REPO_URL } from "@lib/site-config";
import type { ActiveAgentRow } from "./active-agents-content";

// ── Status Badge ─────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  active: "bg-green-500/15 text-green-600",
  completed: "bg-emerald-500/15 text-emerald-500",
  errored: "bg-red-500/15 text-red-500",
  stale: "bg-yellow-500/15 text-yellow-600",
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

// ── Model Badge ──────────────────────────────────────────────────────────

function ModelBadge({ model }: { model: string | null }) {
  if (!model) return <span className="text-xs text-muted-foreground/50">—</span>;

  let label = model;
  let cls = "bg-muted text-muted-foreground";
  if (model.includes("opus")) { label = "opus"; cls = "bg-purple-500/15 text-purple-600"; }
  else if (model.includes("sonnet")) { label = "sonnet"; cls = "bg-amber-500/15 text-amber-600"; }
  else if (model.includes("haiku")) { label = "haiku"; cls = "bg-sky-500/15 text-sky-600"; }

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {label}
    </span>
  );
}

// ── Heartbeat Indicator ──────────────────────────────────────────────────

function HeartbeatCell({ heartbeatAt, status }: { heartbeatAt: string; status: string }) {
  if (status !== "active") {
    return <span className="text-xs text-muted-foreground/50">—</span>;
  }

  const now = Date.now();
  const hb = new Date(heartbeatAt).getTime();
  const minutesAgo = Math.round((now - hb) / 60000);

  let cls = "text-green-600";
  if (minutesAgo > 20) cls = "text-yellow-600";
  if (minutesAgo > 30) cls = "text-red-500";

  return (
    <span className={`text-xs tabular-nums ${cls}`}>
      {minutesAgo < 1 ? "<1m ago" : `${minutesAgo}m ago`}
    </span>
  );
}

// ── Columns ───────────────────────────────────────────────────────────────

const columns: ColumnDef<ActiveAgentRow>[] = [
  {
    accessorKey: "status",
    header: ({ column }) => (
      <SortableHeader column={column}>Status</SortableHeader>
    ),
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "task",
    header: "Task",
    cell: ({ row }) => (
      <span
        className="text-sm max-w-[300px] block truncate"
        title={row.original.task}
      >
        {row.original.task}
      </span>
    ),
  },
  {
    accessorKey: "currentStep",
    header: "Current Step",
    cell: ({ row }) => {
      const step = row.original.currentStep;
      if (!step) return <span className="text-xs text-muted-foreground/50">—</span>;
      return (
        <span
          className="text-xs text-muted-foreground max-w-[200px] block truncate"
          title={step}
        >
          {step}
        </span>
      );
    },
  },
  {
    accessorKey: "issueNumber",
    header: ({ column }) => (
      <SortableHeader column={column}>Issue</SortableHeader>
    ),
    cell: ({ row }) => {
      const num = row.original.issueNumber;
      if (!num)
        return <span className="text-xs text-muted-foreground/50">—</span>;
      return (
        <a
          href={`${GITHUB_REPO_URL}/issues/${num}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline tabular-nums"
        >
          #{num}
        </a>
      );
    },
  },
  {
    accessorKey: "prNumber",
    header: "PR",
    cell: ({ row }) => {
      const num = row.original.prNumber;
      if (!num)
        return <span className="text-xs text-muted-foreground/50">—</span>;
      return (
        <a
          href={`${GITHUB_REPO_URL}/pull/${num}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline tabular-nums"
        >
          #{num}
        </a>
      );
    },
  },
  {
    accessorKey: "model",
    header: ({ column }) => (
      <SortableHeader column={column}>Model</SortableHeader>
    ),
    cell: ({ row }) => <ModelBadge model={row.original.model} />,
  },
  {
    accessorKey: "heartbeatAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Heartbeat</SortableHeader>
    ),
    cell: ({ row }) => (
      <HeartbeatCell
        heartbeatAt={row.original.heartbeatAt}
        status={row.original.status}
      />
    ),
    sortingFn: "datetime",
  },
  {
    accessorKey: "startedAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Started</SortableHeader>
    ),
    cell: ({ row }) => {
      const date = new Date(row.original.startedAt);
      return (
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
          {date.toLocaleDateString()}{" "}
          {date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      );
    },
    sortingFn: "datetime",
  },
  {
    accessorKey: "branch",
    header: "Branch",
    cell: ({ row }) => {
      const branch = row.original.branch;
      if (!branch) return <span className="text-xs text-muted-foreground/50">—</span>;
      return (
        <span
          className="text-xs text-muted-foreground font-mono max-w-[180px] block truncate"
          title={branch}
        >
          {branch}
        </span>
      );
    },
  },
];

// ── Table Component ────────────────────────────────────────────────────────

export function ActiveAgentsTable({ data }: { data: ActiveAgentRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      defaultSorting={[{ id: "startedAt", desc: true }]}
      searchPlaceholder="Search agents..."
    />
  );
}
