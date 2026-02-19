"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { formatAge } from "@lib/format";
import type { IssueRow } from "./types";

function PriorityBadge({ priority }: { priority: number }) {
  const label = priority < 99 ? `P${priority}` : "—";
  const colors: Record<number, string> = {
    0: "bg-red-500/15 text-red-600",
    1: "bg-orange-500/15 text-orange-600",
    2: "bg-yellow-500/15 text-yellow-600",
    3: "bg-blue-500/15 text-blue-600",
  };
  const cls = colors[priority] || "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}
    >
      {label}
    </span>
  );
}

function LabelBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground mr-1">
      {label}
    </span>
  );
}

const columns: ColumnDef<IssueRow>[] = [
  {
    accessorKey: "number",
    header: ({ column }) => <SortableHeader column={column}>#</SortableHeader>,
    cell: ({ row }) => (
      <a
        href={row.original.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs tabular-nums text-blue-600 hover:underline whitespace-nowrap"
      >
        #{row.original.number}
      </a>
    ),
  },
  {
    accessorKey: "priority",
    header: ({ column }) => (
      <SortableHeader column={column}>Priority</SortableHeader>
    ),
    cell: ({ row }) => <PriorityBadge priority={row.original.priority} />,
  },
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column}>Title</SortableHeader>
    ),
    cell: ({ row }) => (
      <div>
        <a
          href={row.original.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium hover:underline"
        >
          {row.original.title}
        </a>
        {row.original.labels.length > 0 && (
          <div className="mt-1">
            {row.original.labels.map((label) => (
              <LabelBadge key={label} label={label} />
            ))}
          </div>
        )}
      </div>
    ),
  },
  {
    accessorKey: "createdAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Created</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {row.original.createdAt}
        <span className="ml-1.5 text-muted-foreground/60">
          ({formatAge(row.original.createdAt)})
        </span>
      </span>
    ),
  },
  {
    accessorKey: "updatedAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Updated</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {row.original.updatedAt}
      </span>
    ),
  },
];

export function IssuesTable({
  data,
  defaultSort,
}: {
  data: IssueRow[];
  defaultSort?: "number" | "priority";
}) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search issues..."
      defaultSorting={
        defaultSort === "priority"
          ? [
              { id: "priority", desc: false },
              { id: "createdAt", desc: false },
            ]
          : [{ id: "number", desc: true }]
      }
    />
  );
}
