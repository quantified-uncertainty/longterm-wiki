"use client";

import { Fragment, useState, useMemo } from "react";
import Link from "next/link";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getFilteredRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CredibilityBadge } from "@/components/wiki/CredibilityBadge";
import { getResourceTypeIcon } from "@/components/wiki/resource-utils";
import type { PublicResourceRow } from "./page";

const TYPE_LABELS: Record<string, string> = {
  paper: "Paper",
  book: "Book",
  blog: "Blog post",
  report: "Report",
  talk: "Talk",
  podcast: "Podcast",
  government: "Government",
  reference: "Reference",
  web: "Web",
};

const columns: ColumnDef<PublicResourceRow>[] = [
  {
    accessorKey: "title",
    header: "Resource",
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm leading-none shrink-0">
            {getResourceTypeIcon(r.type)}
          </span>
          <div className="min-w-0">
            <Link
              href={`/source/${r.id}`}
              className="text-xs font-medium text-blue-600 hover:underline leading-tight"
            >
              {r.title.length > 100 ? r.title.slice(0, 100) + "..." : r.title}
            </Link>
            {r.publicationName && (
              <div className="text-[10px] text-muted-foreground">
                {r.publicationName}
              </div>
            )}
          </div>
        </div>
      );
    },
    size: 400,
    filterFn: (row, _, filterValue) => {
      const search = (filterValue as string).toLowerCase();
      const r = row.original;
      return (
        r.title.toLowerCase().includes(search) ||
        r.id.toLowerCase().includes(search) ||
        (r.publicationName?.toLowerCase().includes(search) ?? false)
      );
    },
  },
  {
    accessorKey: "type",
    header: ({ column }) => (
      <SortableHeader column={column}>Type</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-[10px] text-muted-foreground capitalize">
        {TYPE_LABELS[row.original.type] ?? row.original.type}
      </span>
    ),
    size: 80,
  },
  {
    accessorKey: "citingPageCount",
    header: ({ column }) => (
      <SortableHeader column={column}>Pages</SortableHeader>
    ),
    cell: ({ row }) => {
      const count = row.original.citingPageCount;
      if (count === 0) return <span className="text-muted-foreground/40 text-xs">—</span>;
      return (
        <span className="text-xs tabular-nums font-medium">{count}</span>
      );
    },
    size: 60,
  },
  {
    accessorKey: "credibility",
    header: ({ column }) => (
      <SortableHeader column={column}>Credibility</SortableHeader>
    ),
    cell: ({ row }) => {
      const cred = row.original.credibility;
      if (cred == null) return <span className="text-muted-foreground/40 text-xs">—</span>;
      return <CredibilityBadge level={cred} />;
    },
    size: 80,
  },
  {
    accessorKey: "publishedDate",
    header: ({ column }) => (
      <SortableHeader column={column}>Published</SortableHeader>
    ),
    cell: ({ row }) => {
      const date = row.original.publishedDate;
      if (!date) return <span className="text-muted-foreground/40 text-xs">—</span>;
      return <span className="text-xs text-muted-foreground tabular-nums">{date.slice(0, 10)}</span>;
    },
    size: 90,
  },
];

export function ResourcesTable({
  resources,
}: {
  resources: PublicResourceRow[];
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "citingPageCount", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const filteredResources = useMemo(() => {
    if (typeFilter === "all") return resources;
    return resources.filter((r) => r.type === typeFilter);
  }, [resources, typeFilter]);

  const types = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of resources) {
      counts[r.type] = (counts[r.type] ?? 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [resources]);

  const table = useReactTable({
    data: filteredResources,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _, filterValue) => {
      const search = (filterValue as string).toLowerCase();
      const r = row.original;
      return (
        r.title.toLowerCase().includes(search) ||
        r.id.toLowerCase().includes(search) ||
        (r.publicationName?.toLowerCase().includes(search) ?? false)
      );
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    initialState: { pagination: { pageSize: 30 } },
  });

  return (
    <div>
      {/* Search + filter bar */}
      <div className="flex items-center gap-3 mb-4">
        <input
          type="text"
          placeholder="Search resources..."
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="flex-1 max-w-xs px-3 py-1.5 text-sm border rounded-md bg-background"
        />
        <div className="flex gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => setTypeFilter("all")}
            className={`px-2 py-1 text-[10px] rounded cursor-pointer transition-colors ${
              typeFilter === "all"
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            All ({resources.length})
          </button>
          {types.map(([type, count]) => (
            <button
              key={type}
              type="button"
              onClick={() => setTypeFilter(type === typeFilter ? "all" : type)}
              className={`px-2 py-1 text-[10px] rounded cursor-pointer transition-colors ${
                typeFilter === type
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {TYPE_LABELS[type] ?? type} ({count})
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    style={{ width: header.getSize() }}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length > 0 ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="text-center text-muted-foreground py-8"
                >
                  No resources found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between px-2 py-3 text-sm">
          <span className="text-muted-foreground text-xs">
            {table.getFilteredRowModel().rows.length} resources
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => table.setPageIndex(0)}
              disabled={!table.getCanPreviousPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 cursor-pointer disabled:cursor-default"
            >
              <ChevronsLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 cursor-pointer disabled:cursor-default"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-muted-foreground px-2 tabular-nums">
              {table.getState().pagination.pageIndex + 1} /{" "}
              {table.getPageCount()}
            </span>
            <button
              type="button"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 cursor-pointer disabled:cursor-default"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => table.setPageIndex(table.getPageCount() - 1)}
              disabled={!table.getCanNextPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 cursor-pointer disabled:cursor-default"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
