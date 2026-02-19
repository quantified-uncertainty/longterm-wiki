"use client";

import * as React from "react";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getExpandedRowModel,
} from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { expandToggleColumn } from "@/components/tables/shared/column-helpers";
import { formatAge } from "@lib/format";
import { GITHUB_REPO_URL } from "@lib/site-config";
import { cn } from "@lib/utils";
import { FilterTabs, TableSearchBar } from "../shared";
import type { PrItem } from "@/data";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prState(item: PrItem): string {
  if (item.mergedAt) return "merged";
  return item.state;
}

const stateBadgeStyles: Record<string, string> = {
  merged: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  open: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  closed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const columns: ColumnDef<PrItem>[] = [
  expandToggleColumn<PrItem>(),
  {
    accessorKey: "number",
    header: ({ column }) => (
      <SortableHeader column={column}>#</SortableHeader>
    ),
    cell: ({ row }) => (
      <a
        href={`${GITHUB_REPO_URL}/pull/${row.original.number}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm font-medium text-sky-500 hover:text-sky-600 no-underline tabular-nums"
      >
        #{row.original.number}
      </a>
    ),
    size: 60,
  },
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column}>Title</SortableHeader>
    ),
    cell: ({ row }) => (
      <div className="min-w-[200px] max-w-[400px]">
        <a
          href={`${GITHUB_REPO_URL}/pull/${row.original.number}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-accent-foreground hover:underline no-underline"
        >
          {row.original.title}
        </a>
        {row.original.body && (
          <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
            {row.original.body.slice(0, 200)}
          </p>
        )}
      </div>
    ),
    filterFn: "includesString",
  },
  {
    id: "state",
    accessorFn: (row) => prState(row),
    header: ({ column }) => (
      <SortableHeader column={column}>State</SortableHeader>
    ),
    cell: ({ row }) => {
      const state = prState(row.original);
      return (
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
            stateBadgeStyles[state] || "bg-muted text-muted-foreground"
          )}
        >
          {state}
        </span>
      );
    },
  },
  {
    accessorKey: "author",
    header: ({ column }) => (
      <SortableHeader column={column}>Author</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.author}
      </span>
    ),
  },
  {
    accessorKey: "createdAt",
    header: ({ column }) => (
      <SortableHeader column={column}>Date</SortableHeader>
    ),
    cell: ({ row }) => {
      const date = row.original.mergedAt || row.original.createdAt;
      if (!date) return null;
      const dateStr = date.slice(0, 10);
      return (
        <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
          {dateStr}
          <span className="ml-1.5 text-muted-foreground/60">
            ({formatAge(dateStr)})
          </span>
        </span>
      );
    },
  },
  {
    accessorKey: "branch",
    header: "Branch",
    cell: ({ row }) => (
      <code className="text-[11px] text-muted-foreground truncate max-w-[180px] block">
        {row.original.branch.replace("claude/", "")}
      </code>
    ),
  },
];

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function PrDescriptionsTable({ data }: { data: PrItem[] }) {
  const [stateFilter, setStateFilter] = React.useState<string | null>(null);
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "number", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = React.useState("");

  const dataWithState = React.useMemo(
    () =>
      data.map((item) => ({
        ...item,
        _state: prState(item),
      })),
    [data]
  );

  const filteredData = React.useMemo(
    () =>
      stateFilter
        ? dataWithState.filter((d) => d._state === stateFilter)
        : dataWithState,
    [dataWithState, stateFilter]
  );

  const stateCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of dataWithState) {
      counts[item._state] = (counts[item._state] || 0) + 1;
    }
    return counts;
  }, [dataWithState]);

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    globalFilterFn: "includesString",
  });

  return (
    <div className="space-y-0">
      <FilterTabs
        counts={stateCounts}
        active={stateFilter}
        onSelect={setStateFilter}
        badgeStyles={stateBadgeStyles}
      />
      <TableSearchBar
        value={globalFilter}
        onChange={setGlobalFilter}
        placeholder="Search PRs by title, description, or author..."
        resultCount={table.getFilteredRowModel().rows.length}
        totalCount={filteredData.length}
      />

      <div className="not-prose">
        <DataTable
          table={table}
          renderExpandedRow={(row) =>
            row.getIsExpanded() ? (
              <div className="px-6 py-4 bg-muted/30">
                <div className="flex items-center gap-3 mb-3">
                  <a
                    href={`${GITHUB_REPO_URL}/pull/${row.original.number}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-semibold text-sky-500 hover:text-sky-600 no-underline"
                  >
                    #{row.original.number}
                  </a>
                  <span className="text-sm font-medium">
                    {row.original.title}
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                      stateBadgeStyles[prState(row.original)] ||
                        "bg-muted text-muted-foreground"
                    )}
                  >
                    {prState(row.original)}
                  </span>
                </div>
                {row.original.body ? (
                  <div className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed max-w-3xl max-h-[400px] overflow-y-auto">
                    {row.original.body}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    No description provided.
                  </p>
                )}
                {row.original.labels.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {row.original.labels.map((label) => (
                      <span
                        key={label}
                        className="text-[10px] bg-muted rounded-full px-2 py-0.5 font-medium"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : null
          }
          getRowClassName={(row) =>
            row.getIsExpanded() ? "bg-muted/20" : ""
          }
        />
      </div>
    </div>
  );
}
