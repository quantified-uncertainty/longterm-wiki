"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { formatAge } from "@lib/format";
import type { RpcResourcePipelineRow } from "@lib/wiki-server";

const FETCH_STATUS_COLOR: Record<string, string> = {
  ok: "text-emerald-600",
  paywall: "text-amber-600",
  dead: "text-red-600",
  soft_404: "text-red-600",
  not_found: "text-red-600",
  timeout: "text-orange-600",
  unreachable: "text-orange-600",
  error: "text-red-600",
};

const ENRICHMENT_STATUS_COLOR: Record<string, string> = {
  reviewed: "text-emerald-600",
  enriched: "text-emerald-600",
  classified: "text-blue-600",
  fetched: "text-yellow-600",
  pending: "text-muted-foreground",
};

const columns: ColumnDef<RpcResourcePipelineRow>[] = [
  {
    accessorKey: "title",
    header: "Title",
    cell: ({ row }) => {
      const title = row.original.title || "(no title)";
      return (
        <span className="text-xs truncate max-w-[320px] block" title={title}>
          {title}
        </span>
      );
    },
  },
  {
    accessorKey: "url",
    header: "URL",
    cell: ({ row }) => (
      <a
        href={row.original.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-blue-600 hover:underline truncate max-w-[280px] block"
        title={row.original.url}
      >
        {row.original.url}
      </a>
    ),
  },
  {
    accessorKey: "fetchStatus",
    header: ({ column }) => (
      <SortableHeader column={column}>Fetch</SortableHeader>
    ),
    cell: ({ row }) => {
      const status = row.original.fetchStatus ?? "unknown";
      const color = FETCH_STATUS_COLOR[status] ?? "text-muted-foreground";
      return <span className={`text-xs font-mono ${color}`}>{status}</span>;
    },
  },
  {
    accessorKey: "enrichmentStatus",
    header: ({ column }) => (
      <SortableHeader column={column}>Enrichment</SortableHeader>
    ),
    cell: ({ row }) => {
      const status = row.original.enrichmentStatus ?? "none";
      const color =
        ENRICHMENT_STATUS_COLOR[status] ?? "text-muted-foreground/60";
      return <span className={`text-xs font-mono ${color}`}>{status}</span>;
    },
  },
  {
    accessorKey: "lastFetchedAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Last fetched</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {formatAge(row.original.lastFetchedAt)}
      </span>
    ),
  },
];

export function ResourceListTable({ data }: { data: RpcResourcePipelineRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search by title or URL..."
      defaultSorting={[{ id: "lastFetchedAt", desc: true }]}
    />
  );
}
