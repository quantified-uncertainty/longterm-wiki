"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { UpdateScheduleItem } from "@/data";

function formatFrequency(days: number): string {
  if (days <= 7) return "Weekly";
  if (days <= 14) return "Biweekly";
  if (days <= 21) return "3 weeks";
  if (days <= 30) return "Monthly";
  if (days <= 45) return "6 weeks";
  if (days <= 60) return "Bimonthly";
  if (days <= 90) return "Quarterly";
  return `${Math.round(days / 30)}mo`;
}

function formatDaysUntil(days: number): string {
  if (days < -30) return `${Math.abs(Math.round(days / 7))}w overdue`;
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Today";
  if (days <= 14) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

function StatusBadge({ daysUntil }: { daysUntil: number }) {
  if (daysUntil < 0) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-500/15 text-red-500">
        {formatDaysUntil(daysUntil)}
      </span>
    );
  }
  if (daysUntil <= 7) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-500/15 text-amber-500">
        {formatDaysUntil(daysUntil)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-500/15 text-emerald-500">
      {formatDaysUntil(daysUntil)}
    </span>
  );
}

const columns: ColumnDef<UpdateScheduleItem>[] = [
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column}>Title</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/wiki/${row.original.numericId}`}
        className="text-sm font-medium text-accent-foreground hover:underline no-underline"
      >
        {row.original.title}
      </Link>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "updateFrequency",
    header: ({ column }) => (
      <SortableHeader column={column}>Frequency</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {formatFrequency(row.original.updateFrequency)}
      </span>
    ),
  },
  {
    accessorKey: "daysSinceUpdate",
    header: ({ column }) => (
      <SortableHeader column={column}>Last Edit</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground tabular-nums">
        {row.original.daysSinceUpdate < 999
          ? `${row.original.daysSinceUpdate}d ago`
          : "Unknown"}
      </span>
    ),
  },
  {
    accessorKey: "daysUntilDue",
    header: ({ column }) => (
      <SortableHeader column={column}>Status</SortableHeader>
    ),
    cell: ({ row }) => <StatusBadge daysUntil={row.original.daysUntilDue} />,
  },
  {
    accessorKey: "importance",
    header: ({ column }) => (
      <SortableHeader column={column}>Imp.</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.importance != null
          ? Math.round(row.original.importance)
          : "-"}
      </span>
    ),
  },
  {
    accessorKey: "priority",
    header: ({ column }) => (
      <SortableHeader column={column}>Priority</SortableHeader>
    ),
    cell: ({ row }) => {
      const p = row.original.priority;
      const color =
        p >= 2
          ? "text-red-500 font-semibold"
          : p >= 1
            ? "text-amber-500 font-medium"
            : "text-muted-foreground";
      return <span className={`text-xs tabular-nums ${color}`}>{p.toFixed(2)}</span>;
    },
  },
];

export function UpdatesTable({ data }: { data: UpdateScheduleItem[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search pages..."
      defaultSorting={[{ id: "priority", desc: true }]}
      getRowClassName={(row) =>
        row.original.daysUntilDue < 0 ? "bg-red-500/[0.03]" : ""
      }
    />
  );
}
