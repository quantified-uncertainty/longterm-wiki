"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { GITHUB_REPO_URL } from "@lib/site-config";
import { shortenDirectory } from "@lib/format";
import type { AgentSessionListRow as AgentSessionRow } from "@wiki-server/api-response-types";

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

// ── Outcome Badge ────────────────────────────────────────────────────────

const OUTCOME_STYLES: Record<string, string> = {
  merged: "bg-emerald-500/15 text-emerald-600",
  merged_with_revisions: "bg-blue-500/15 text-blue-600",
  reverted: "bg-red-500/15 text-red-600",
  closed_without_merge: "bg-gray-500/15 text-gray-600",
};

const OUTCOME_LABELS: Record<string, string> = {
  merged: "merged",
  merged_with_revisions: "merged+",
  reverted: "reverted",
  closed_without_merge: "closed",
};

function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return <span className="text-xs text-muted-foreground/50">—</span>;
  const style = OUTCOME_STYLES[outcome] ?? "bg-muted text-muted-foreground";
  const label = OUTCOME_LABELS[outcome] ?? outcome;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style}`}>
      {label}
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
  // QUA-440: Slot number — populated for sessions after QUA-440 lands.
  // Older sessions show '—'.
  {
    accessorKey: "slotNumber",
    header: ({ column }) => (
      <SortableHeader column={column}>Slot</SortableHeader>
    ),
    cell: ({ row }) => {
      const slot = (row.original as { slotNumber?: number | null }).slotNumber;
      if (slot === null || slot === undefined) {
        return <span className="text-xs text-muted-foreground/50">—</span>;
      }
      return (
        <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold text-foreground/90">
          a{slot}
        </span>
      );
    },
    sortingFn: (a, b) =>
      ((a.original as { slotNumber?: number | null }).slotNumber ?? -1) -
      ((b.original as { slotNumber?: number | null }).slotNumber ?? -1),
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
  // QUA-440: Linear issue ID, linked to Linear's issue page.
  {
    accessorKey: "linearId",
    header: ({ column }) => (
      <SortableHeader column={column}>Linear</SortableHeader>
    ),
    cell: ({ row }) => {
      const id = (row.original as { linearId?: string | null }).linearId;
      if (!id) return <span className="text-xs text-muted-foreground/50">—</span>;
      return (
        <a
          href={`https://linear.app/quantifieduncertainty/issue/${id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono text-blue-600 hover:underline"
        >
          {id}
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
    accessorKey: "fixesPrUrl",
    header: "Fixes",
    cell: ({ row }) => {
      const url = row.original.fixesPrUrl;
      if (!url)
        return <span className="text-xs text-muted-foreground/50">—</span>;
      const prNum = url.match(/\/pull\/(\d+)/)?.[1];
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-orange-600 hover:underline tabular-nums"
          title="This session fixed issues from this PR"
        >
          {prNum ? `#${prNum}` : "PR"}
        </a>
      );
    },
  },
  {
    accessorKey: "prOutcome",
    header: ({ column }) => (
      <SortableHeader column={column}>Outcome</SortableHeader>
    ),
    cell: ({ row }) => <OutcomeBadge outcome={row.original.prOutcome} />,
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
    accessorKey: "worktree",
    header: "Directory",
    cell: ({ row }) => {
      const worktree = row.original.worktree;
      if (!worktree) return <span className="text-xs text-muted-foreground/50">—</span>;
      return (
        <span
          className="text-xs text-muted-foreground font-mono max-w-[200px] block truncate"
          title={worktree}
        >
          {shortenDirectory(worktree)}
        </span>
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

// ── Outcome Filter Buttons ─────────────────────────────────────────────────

const OUTCOME_FILTERS: ReadonlyArray<{ value: string | null; label: string; style: string }> = [
  { value: null, label: "All", style: "" },
  { value: "merged", label: "Merged", style: "text-emerald-600" },
  { value: "merged_with_revisions", label: "Merged+", style: "text-blue-600" },
  { value: "reverted", label: "Reverted", style: "text-red-600" },
  { value: "closed_without_merge", label: "Closed", style: "text-gray-600" },
  { value: "none", label: "No outcome", style: "text-muted-foreground" },
];

function OutcomeFilterBar({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground mr-1">Outcome:</span>
      {OUTCOME_FILTERS.map((f) => (
        <button
          key={f.value ?? "all"}
          onClick={() => onChange(f.value)}
          className={`rounded-full px-2.5 py-0.5 font-medium transition-colors ${
            value === f.value
              ? "bg-foreground/10 ring-1 ring-foreground/20"
              : "hover:bg-muted"
          } ${f.style ?? ""}`}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

// ── Table Component ────────────────────────────────────────────────────────

export function AgentSessionsTable({ data }: { data: AgentSessionRow[] }) {
  const [outcomeFilter, setOutcomeFilter] = useState<string | null>(null);

  const filteredData = outcomeFilter
    ? outcomeFilter === "none"
      ? data.filter((s) => !s.prOutcome)
      : data.filter((s) => s.prOutcome === outcomeFilter)
    : data;

  return (
    <div className="space-y-3">
      <OutcomeFilterBar value={outcomeFilter} onChange={setOutcomeFilter} />
      <DataTable
        columns={columns}
        data={filteredData}
        defaultSorting={[{ id: "startedAt", desc: true }]}
        searchPlaceholder="Search tasks..."
      />
    </div>
  );
}
