"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { EntityQualityRow } from "./page";

function QualityBadge({ score }: { score: number }) {
  const color =
    score >= 80
      ? "bg-emerald-500/15 text-emerald-600"
      : score >= 50
        ? "bg-amber-500/15 text-amber-600"
        : "bg-red-500/15 text-red-600";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${color}`}
    >
      {score}%
    </span>
  );
}

function IssueCount({ count, total }: { count: number; total: number }) {
  if (count === 0) {
    return (
      <span className="text-xs tabular-nums text-muted-foreground/50">0</span>
    );
  }
  const pct = total > 0 ? ((count / total) * 100).toFixed(0) : "0";
  return (
    <span className="text-xs tabular-nums text-muted-foreground">
      <span className="font-semibold text-foreground">{count}</span>
      <span className="text-muted-foreground/60 ml-1">({pct}%)</span>
    </span>
  );
}

const columns: ColumnDef<EntityQualityRow>[] = [
  {
    accessorKey: "entityId",
    header: ({ column }) => (
      <SortableHeader column={column}>Entity</SortableHeader>
    ),
    cell: ({ row }) => (
      <span
        className="text-xs font-mono truncate max-w-[220px] inline-block"
        title={row.original.entityId}
      >
        {row.original.entityId}
      </span>
    ),
  },
  {
    accessorKey: "totalClaims",
    header: ({ column }) => (
      <SortableHeader column={column}>Total</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums font-semibold">
        {row.original.totalClaims}
      </span>
    ),
  },
  {
    accessorKey: "cleanClaims",
    header: ({ column }) => (
      <SortableHeader column={column}>Clean</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-emerald-600 font-medium">
        {row.original.cleanClaims}
      </span>
    ),
  },
  {
    accessorKey: "duplicateCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Duplicates</SortableHeader>
    ),
    cell: ({ row }) => (
      <IssueCount
        count={row.original.duplicateCount}
        total={row.original.totalClaims}
      />
    ),
  },
  {
    accessorKey: "markupCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Markup</SortableHeader>
    ),
    cell: ({ row }) => (
      <IssueCount
        count={row.original.markupCount}
        total={row.original.totalClaims}
      />
    ),
  },
  {
    accessorKey: "missingRelatedEntities",
    header: ({ column }) => (
      <SortableHeader column={column}>No Related</SortableHeader>
    ),
    cell: ({ row }) => (
      <IssueCount
        count={row.original.missingRelatedEntities}
        total={row.original.totalClaims}
      />
    ),
  },
  {
    accessorKey: "qualityScore",
    header: ({ column }) => (
      <SortableHeader column={column}>Quality</SortableHeader>
    ),
    cell: ({ row }) => <QualityBadge score={row.original.qualityScore} />,
  },
];

export function ClaimsQualityTable({ data }: { data: EntityQualityRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search entities..."
      defaultSorting={[{ id: "totalClaims", desc: true }]}
      getRowClassName={(row) =>
        row.original.qualityScore < 50 ? "bg-red-500/[0.03]" : ""
      }
    />
  );
}
