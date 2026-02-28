"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { IncidentDisplayRow } from "./system-health-content";

// ── Severity Badge ──────────────────────────────────────────────────────

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-500/15 text-red-500",
  warning: "bg-yellow-500/15 text-yellow-600",
  info: "bg-blue-500/15 text-blue-600",
};

function SeverityBadge({ severity }: { severity: string }) {
  const style = SEVERITY_STYLES[severity] ?? "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style}`}
    >
      {severity}
    </span>
  );
}

// ── Status Badge ────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, string> = {
  open: "bg-red-500/15 text-red-500",
  acknowledged: "bg-yellow-500/15 text-yellow-600",
  resolved: "bg-green-500/15 text-green-600",
};

function IncidentStatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style}`}
    >
      {status}
    </span>
  );
}

// ── Service Label ───────────────────────────────────────────────────────

const SERVICE_LABELS: Record<string, string> = {
  "wiki-server": "Wiki Server",
  groundskeeper: "Groundskeeper",
  "discord-bot": "Discord Bot",
  "vercel-frontend": "Vercel",
  "github-actions": "GH Actions",
};

// ── Columns ─────────────────────────────────────────────────────────────

const columns: ColumnDef<IncidentDisplayRow>[] = [
  {
    accessorKey: "detectedAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Detected</SortableHeader>
    ),
    cell: ({ row }) => {
      const date = new Date(row.original.detectedAt);
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
    sortingFn: "datetime",
  },
  {
    accessorKey: "service",
    header: ({ column }) => (
      <SortableHeader column={column}>Service</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-sm font-medium">
        {SERVICE_LABELS[row.original.service] ?? row.original.service}
      </span>
    ),
  },
  {
    accessorKey: "severity",
    header: ({ column }) => (
      <SortableHeader column={column}>Severity</SortableHeader>
    ),
    cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
  },
  {
    accessorKey: "title",
    header: "Title",
    cell: ({ row }) => (
      <span
        className="text-xs text-muted-foreground max-w-[300px] block truncate"
        title={row.original.title}
      >
        {row.original.title}
      </span>
    ),
  },
  {
    accessorKey: "status",
    header: ({ column }) => (
      <SortableHeader column={column}>Status</SortableHeader>
    ),
    cell: ({ row }) => (
      <IncidentStatusBadge status={row.original.status} />
    ),
  },
  {
    accessorKey: "checkSource",
    header: "Source",
    cell: ({ row }) => {
      const src = row.original.checkSource;
      if (!src) {
        return (
          <span className="text-xs text-muted-foreground/50">&mdash;</span>
        );
      }
      return <span className="text-xs text-muted-foreground">{src}</span>;
    },
  },
  {
    accessorKey: "resolvedAt",
    header: "Resolved",
    cell: ({ row }) => {
      const resolved = row.original.resolvedAt;
      if (!resolved) {
        return (
          <span className="text-xs text-muted-foreground/50">&mdash;</span>
        );
      }
      const date = new Date(resolved);
      return (
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
          {date.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      );
    },
  },
];

// ── Table Component ─────────────────────────────────────────────────────

export function SystemHealthTable({
  data,
}: {
  data: IncidentDisplayRow[];
}) {
  return (
    <DataTable
      columns={columns}
      data={data}
      defaultSorting={[{ id: "detectedAt", desc: true }]}
      searchPlaceholder="Search incidents..."
    />
  );
}
