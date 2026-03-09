"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { InsightRow } from "./session-insights-content";

function TypeBadge({ type }: { type: string }) {
  const style =
    type === "learning"
      ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
      : "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${style}`}
    >
      {type}
    </span>
  );
}

const columns: ColumnDef<InsightRow>[] = [
  {
    accessorKey: "date",
    header: ({ column }) => (
      <SortableHeader column={column}>Date</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
        {row.original.date ?? "\u2014"}
      </span>
    ),
  },
  {
    accessorKey: "branch",
    header: ({ column }) => (
      <SortableHeader column={column}>Branch</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs font-mono text-muted-foreground">
        {row.original.branch || "\u2014"}
      </span>
    ),
  },
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column}>Session</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-sm">{row.original.title ?? "\u2014"}</span>
    ),
  },
  {
    accessorKey: "type",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => <TypeBadge type={row.original.type} />,
    filterFn: "equals",
  },
  {
    accessorKey: "text",
    header: "Insight",
    cell: ({ row }) => (
      <p className="text-sm max-w-md">{row.original.text}</p>
    ),
  },
];

export function InsightsTable({ data }: { data: InsightRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      defaultSorting={[{ id: "date", desc: true }]}
      searchPlaceholder="Search insights..."
    />
  );
}
