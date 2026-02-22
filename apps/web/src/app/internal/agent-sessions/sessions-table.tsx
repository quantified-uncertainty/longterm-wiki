"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { AgentSessionRow } from "./page";

// ── Status Badge ─────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  active: "bg-yellow-500/15 text-yellow-600",
  completed: "bg-emerald-500/15 text-emerald-500",
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

function normalizeModel(model: string | null): string | null {
  if (!model) return null;
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return model;
}

function ModelBadge({ model }: { model: string | null }) {
  if (!model) return <span className="text-xs text-muted-foreground/50">—</span>;
  const normalized = normalizeModel(model);

  let cls = "bg-muted text-muted-foreground";
  if (model.includes("opus")) cls = "bg-purple-500/15 text-purple-600";
  else if (model.includes("sonnet")) cls = "bg-amber-500/15 text-amber-600";
  else if (model.includes("haiku")) cls = "bg-sky-500/15 text-sky-600";

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {normalized ?? model}
    </span>
  );
}

// ── Session Type Badge ────────────────────────────────────────────────────

const TYPE_STYLES: Record<string, string> = {
  content: "bg-blue-500/15 text-blue-600",
  infrastructure: "bg-slate-500/15 text-slate-600",
  bugfix: "bg-red-500/15 text-red-500",
  refactor: "bg-orange-500/15 text-orange-600",
  commands: "bg-green-500/15 text-green-600",
};

function TypeBadge({ type }: { type: string }) {
  const style = TYPE_STYLES[type] ?? "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style}`}>
      {type}
    </span>
  );
}

// ── Columns ───────────────────────────────────────────────────────────────

const columns: ColumnDef<AgentSessionRow>[] = [
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
    accessorKey: "status",
    header: ({ column }) => (
      <SortableHeader column={column}>Status</SortableHeader>
    ),
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  {
    accessorKey: "sessionType",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => <TypeBadge type={row.original.sessionType} />,
  },
  {
    accessorKey: "task",
    header: "Task",
    cell: ({ row }) => {
      const display = row.original.title ?? row.original.task;
      return (
        <span
          className="text-sm max-w-[300px] block truncate"
          title={display}
        >
          {display}
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
          href={`https://github.com/quantified-uncertainty/longterm-wiki/issues/${num}`}
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
    accessorKey: "prUrl",
    header: "PR",
    cell: ({ row }) => {
      const url = row.original.prUrl;
      if (!url)
        return <span className="text-xs text-muted-foreground/50">—</span>;
      const prNum = url.match(/\/pull\/(\d+)/)?.[1];
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:underline tabular-nums"
        >
          {prNum ? `#${prNum}` : "PR"}
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
    accessorKey: "cost",
    header: ({ column }) => (
      <SortableHeader column={column}>Cost</SortableHeader>
    ),
    cell: ({ row }) => {
      const cost = row.original.cost;
      return cost ? (
        <span className="text-xs tabular-nums text-muted-foreground">
          {cost}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground/50">—</span>
      );
    },
  },
  {
    accessorKey: "branch",
    header: "Branch",
    cell: ({ row }) => {
      const branch = row.original.branch;
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

export function AgentSessionsTable({ data }: { data: AgentSessionRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      defaultSorting={[{ id: "startedAt", desc: true }]}
      searchPlaceholder="Search tasks..."
    />
  );
}
