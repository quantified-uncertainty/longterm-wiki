"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { formatAge } from "@lib/format";
import type { ImproveRunRow } from "./improve-runs-content";

function EngineBadge({ engine }: { engine: string }) {
  const isV2 = engine === "v2";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
        isV2
          ? "bg-violet-500/10 text-violet-600"
          : "bg-muted text-muted-foreground"
      }`}
    >
      {isV2 ? "V2 orchestrator" : "V1 pipeline"}
    </span>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    polish: "bg-blue-500/10 text-blue-600",
    standard: "bg-amber-500/10 text-amber-700",
    deep: "bg-purple-500/10 text-purple-600",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        colors[tier] ?? "bg-muted text-muted-foreground"
      }`}
    >
      {tier}
    </span>
  );
}

function QualityBadge({ passed }: { passed: boolean | null }) {
  if (passed === null) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
        n/a
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        passed
          ? "bg-emerald-500/15 text-emerald-500"
          : "bg-red-500/15 text-red-500"
      }`}
    >
      {passed ? "passed" : "failed"}
    </span>
  );
}

const columns: ColumnDef<ImproveRunRow>[] = [
  {
    accessorKey: "startedAt",
    header: ({ column }) => <SortableHeader column={column}>Date</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-xs whitespace-nowrap" title={row.original.startedAt}>
        {formatAge(row.original.startedAt)}
      </span>
    ),
  },
  {
    accessorKey: "pageId",
    header: ({ column }) => <SortableHeader column={column}>Page</SortableHeader>,
    cell: ({ row }) => (
      <a
        href={`/wiki/${row.original.pageId}`}
        className="text-xs font-mono text-blue-600 hover:underline truncate max-w-[200px] inline-block"
        title={row.original.pageId}
      >
        {row.original.pageId}
      </a>
    ),
  },
  {
    accessorKey: "engine",
    header: "Engine",
    cell: ({ row }) => <EngineBadge engine={row.original.engine} />,
  },
  {
    accessorKey: "tier",
    header: "Tier",
    cell: ({ row }) => <TierBadge tier={row.original.tier} />,
  },
  {
    accessorKey: "totalCost",
    header: ({ column }) => <SortableHeader column={column}>Cost</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-xs font-mono">
        {row.original.totalCost != null
          ? `$${row.original.totalCost.toFixed(2)}`
          : "-"}
      </span>
    ),
  },
  {
    accessorKey: "durationS",
    header: ({ column }) => <SortableHeader column={column}>Duration</SortableHeader>,
    cell: ({ row }) => {
      const s = row.original.durationS;
      if (s == null) return <span className="text-xs text-muted-foreground">-</span>;
      const m = Math.floor(s / 60);
      const sec = Math.round(s % 60);
      return (
        <span className="text-xs font-mono">
          {m > 0 ? `${m}m ${sec}s` : `${sec}s`}
        </span>
      );
    },
  },
  {
    accessorKey: "qualityGatePassed",
    header: "Quality",
    cell: ({ row }) => (
      <QualityBadge passed={row.original.qualityGatePassed} />
    ),
  },
  {
    accessorKey: "sourceCacheCount",
    header: "Sources",
    cell: ({ row }) => (
      <span className="text-xs font-mono">
        {row.original.sourceCacheCount}
      </span>
    ),
  },
  {
    accessorKey: "hasCitationAudit",
    header: "Audit",
    cell: ({ row }) => (
      <span className="text-xs">
        {row.original.hasCitationAudit ? "yes" : "-"}
      </span>
    ),
  },
  {
    accessorKey: "toolCallCount",
    header: "Tools",
    cell: ({ row }) => (
      <span className="text-xs font-mono">
        {row.original.toolCallCount ?? "-"}
      </span>
    ),
  },
];

export function RunsTable({ data }: { data: ImproveRunRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      defaultSorting={[{ id: "startedAt", desc: true }]}
    />
  );
}
