"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";

export interface SuggestedPage {
  title: string;
  type: string;
  priority: number;
  mentions: number;
  reason: string;
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground whitespace-nowrap">
      {type}
    </span>
  );
}

const columns: ColumnDef<SuggestedPage>[] = [
  {
    accessorKey: "priority",
    header: ({ column }) => (
      <SortableHeader column={column}>Priority</SortableHeader>
    ),
    cell: ({ row }) => {
      const p = row.original.priority;
      const color =
        p >= 90
          ? "text-red-500 font-semibold"
          : p >= 70
            ? "text-amber-500 font-medium"
            : "text-muted-foreground";
      return (
        <span className={`text-xs tabular-nums ${color}`}>{p}</span>
      );
    },
  },
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column}>Suggested Page</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-sm font-medium">{row.original.title}</span>
    ),
  },
  {
    accessorKey: "type",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => <TypeBadge type={row.original.type} />,
  },
  {
    accessorKey: "mentions",
    header: ({ column }) => (
      <SortableHeader column={column}>Mentions</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.mentions > 0 ? row.original.mentions : "—"}
      </span>
    ),
  },
  {
    accessorKey: "reason",
    header: "Why",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground leading-relaxed">
        {row.original.reason}
      </span>
    ),
    enableSorting: false,
  },
];

export function SuggestedPagesTable({ data }: { data: SuggestedPage[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search suggested pages..."
      defaultSorting={[{ id: "priority", desc: true }]}
    />
  );
}
