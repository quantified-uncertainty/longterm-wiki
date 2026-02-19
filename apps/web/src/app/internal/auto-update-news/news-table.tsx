"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { NewsRow } from "./page";

function RelevanceBadge({ score }: { score: number }) {
  const color =
    score >= 70
      ? "bg-emerald-500/15 text-emerald-600"
      : score >= 40
        ? "bg-amber-500/15 text-amber-600"
        : "bg-muted text-muted-foreground";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${color}`}
    >
      {score}
    </span>
  );
}

function RoutingBadge({
  routedTo,
  tier,
}: {
  routedTo: string | null;
  tier: string | null;
}) {
  if (!routedTo) {
    return (
      <span className="text-[11px] text-muted-foreground/50 italic">
        not routed
      </span>
    );
  }

  const tierColor =
    tier === "deep"
      ? "bg-red-500/10 text-red-600"
      : tier === "standard"
        ? "bg-blue-500/10 text-blue-600"
        : "bg-muted text-muted-foreground";

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-foreground truncate max-w-[180px]">
        {routedTo}
      </span>
      <span
        className={`inline-flex items-center self-start rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tierColor}`}
      >
        {tier}
      </span>
    </div>
  );
}

const columns: ColumnDef<NewsRow>[] = [
  {
    accessorKey: "relevanceScore",
    header: ({ column }) => (
      <SortableHeader column={column}>Score</SortableHeader>
    ),
    cell: ({ row }) => (
      <RelevanceBadge score={row.original.relevanceScore} />
    ),
  },
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column}>Title</SortableHeader>
    ),
    cell: ({ row }) => (
      <div className="max-w-[350px]">
        {row.original.url ? (
          <a
            href={row.original.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-accent-foreground hover:underline no-underline"
          >
            {row.original.title}
          </a>
        ) : (
          <span className="text-sm font-medium text-foreground">
            {row.original.title}
          </span>
        )}
        {row.original.summary && (
          <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
            {row.original.summary.slice(0, 200)}
          </p>
        )}
      </div>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "sourceId",
    header: ({ column }) => (
      <SortableHeader column={column}>Source</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
        {row.original.sourceId}
      </span>
    ),
  },
  {
    accessorKey: "publishedAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Published</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {row.original.publishedAt}
      </span>
    ),
  },
  {
    accessorKey: "routedTo",
    header: ({ column }) => (
      <SortableHeader column={column}>Routed To</SortableHeader>
    ),
    cell: ({ row }) => (
      <RoutingBadge
        routedTo={row.original.routedTo}
        tier={row.original.routedTier}
      />
    ),
    sortingFn: (rowA, rowB) => {
      const a = rowA.original.routedTo ? 1 : 0;
      const b = rowB.original.routedTo ? 1 : 0;
      return a - b;
    },
  },
  {
    accessorKey: "runDate",
    header: ({ column }) => (
      <SortableHeader column={column}>Run</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.runDate}
      </span>
    ),
  },
];

export function NewsTable({ data }: { data: NewsRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search news items..."
      defaultSorting={[{ id: "relevanceScore", desc: true }]}
      getRowClassName={(row) =>
        row.original.routedTo ? "bg-emerald-500/[0.02]" : ""
      }
    />
  );
}
