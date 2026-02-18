"use client";

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { formatAge } from "@lib/format";
import { GITHUB_REPO_URL } from "@lib/site-config";
import type { PageChangeItem } from "@/data";

const columns: ColumnDef<PageChangeItem>[] = [
  {
    accessorKey: "date",
    header: ({ column }) => (
      <SortableHeader column={column}>Date</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {row.original.date}
        <span className="ml-1.5 text-muted-foreground/60">
          ({formatAge(row.original.date)})
        </span>
      </span>
    ),
  },
  {
    accessorKey: "pageTitle",
    header: ({ column }) => (
      <SortableHeader column={column}>Page</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={row.original.pagePath}
        className="text-sm font-medium text-accent-foreground hover:underline no-underline"
      >
        {row.original.pageTitle}
      </Link>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "sessionTitle",
    header: ({ column }) => (
      <SortableHeader column={column}>Session</SortableHeader>
    ),
    cell: ({ row }) => (
      <div className="max-w-[300px]">
        <span className="text-xs font-medium text-foreground">
          {row.original.sessionTitle}
        </span>
        {row.original.summary && (
          <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-1 leading-relaxed">
            {row.original.summary}
          </p>
        )}
        {(row.original.duration || row.original.cost) && (
          <p className="mt-0.5 text-[11px] text-muted-foreground/60">
            {[row.original.duration, row.original.cost]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>
    ),
  },
  {
    accessorKey: "model",
    header: ({ column }) => (
      <SortableHeader column={column}>Model</SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.model ? (
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 whitespace-nowrap">
          {row.original.model}
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground/40">—</span>
      ),
  },
  {
    accessorKey: "category",
    header: ({ column }) => (
      <SortableHeader column={column}>Category</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">
        {row.original.category}
      </span>
    ),
  },
  {
    accessorKey: "branch",
    header: "Branch / PR",
    cell: ({ row }) => (
      <div className="flex items-center gap-1.5">
        <code className="text-[11px] text-muted-foreground">
          {row.original.branch.replace("claude/", "")}
        </code>
        {row.original.pr && (
          <a
            href={`${GITHUB_REPO_URL}/pull/${row.original.pr}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-sky-500 hover:text-sky-600 no-underline font-medium"
          >
            #{row.original.pr}
          </a>
        )}
      </div>
    ),
  },
];

export function PageChangesTable({ data }: { data: PageChangeItem[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search pages or sessions..."
      defaultSorting={[{ id: "date", desc: true }]}
    />
  );
}
