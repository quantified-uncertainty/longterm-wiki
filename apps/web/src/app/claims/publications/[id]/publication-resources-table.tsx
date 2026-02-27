"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  Search,
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

export interface PublicationResourceRow {
  id: string;
  title: string;
  type: string;
  publishedDate: string | null;
  hasSummary: boolean;
  citingPageCount: number;
}

/** Approximate row height in px for spacer calculation (keeps table height stable across pages) */
const TABLE_ROW_HEIGHT_PX = 37;

const TYPE_COLORS: Record<string, string> = {
  paper: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  blog: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  report: "bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300",
  book: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  web: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  government:
    "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300",
  talk: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  podcast: "bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300",
  reference: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
};
const DEFAULT_TYPE_COLOR =
  "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";

function makeColumns(): ColumnDef<PublicationResourceRow>[] {
  return [
    {
      accessorKey: "title",
      header: ({ column }) => (
        <SortableHeader column={column}>Title</SortableHeader>
      ),
      cell: ({ row }) => (
        <Link
          href={`/source/${row.original.id}`}
          className="text-primary hover:underline text-xs font-medium max-w-[350px] truncate block"
          title={row.original.title}
        >
          {row.original.title}
        </Link>
      ),
      filterFn: "includesString",
    },
    {
      accessorKey: "type",
      header: ({ column }) => (
        <SortableHeader column={column}>Type</SortableHeader>
      ),
      cell: ({ row }) => {
        const t = row.original.type;
        const color = TYPE_COLORS[t] || DEFAULT_TYPE_COLOR;
        return (
          <span className={`text-xs px-1.5 py-0.5 rounded ${color}`}>{t}</span>
        );
      },
    },
    {
      accessorKey: "publishedDate",
      header: ({ column }) => (
        <SortableHeader column={column}>Published</SortableHeader>
      ),
      cell: ({ row }) => {
        const d = row.original.publishedDate;
        if (!d)
          return (
            <span className="text-muted-foreground/40 text-xs">-</span>
          );
        return (
          <span className="text-xs text-muted-foreground font-mono">
            {d.length > 7 ? d.slice(0, 10) : d}
          </span>
        );
      },
      sortUndefined: "last",
    },
    {
      accessorKey: "hasSummary",
      header: "Summary",
      cell: ({ row }) => (
        <span
          className={`text-[10px] w-4 h-4 flex items-center justify-center rounded ${
            row.original.hasSummary
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
              : "bg-muted text-muted-foreground/30"
          }`}
          title={row.original.hasSummary ? "Has summary" : "No summary"}
        >
          S
        </span>
      ),
    },
    {
      accessorKey: "citingPageCount",
      header: ({ column }) => (
        <SortableHeader column={column}>Pages</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="text-xs tabular-nums text-muted-foreground">
          {row.original.citingPageCount}
        </span>
      ),
    },
  ];
}

export function PublicationResourcesTable({
  resources,
}: {
  resources: PublicationResourceRow[];
}) {
  const columns = useMemo(() => makeColumns(), []);

  const [sorting, setSorting] = useState<SortingState>([
    { id: "citingPageCount", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });

  const table = useReactTable({
    data: resources,
    columns,
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: setPagination,
    state: { sorting, globalFilter, pagination },
  });

  const filtered = table.getFilteredRowModel().rows.length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search resources..."
            value={globalFilter ?? ""}
            onChange={(e) => {
              setGlobalFilter(e.target.value);
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            className="h-9 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filtered} resource{filtered !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="rounded-lg border border-border/60 shadow-sm max-h-[60vh] overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-20">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                key={headerGroup.id}
                className="hover:bg-transparent border-b-2 border-border/60"
              >
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="whitespace-nowrap">
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
            {table.getRowModel().rows?.length ? (
              <>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="py-1.5">
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {/* Spacer row to maintain consistent table height across pages */}
                {table.getRowModel().rows.length < pagination.pageSize && (
                  <tr>
                    <td
                      colSpan={columns.length}
                      style={{ height: `${(pagination.pageSize - table.getRowModel().rows.length) * TABLE_ROW_HEIGHT_PX}px` }}
                    />
                  </tr>
                )}
              </>
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
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
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              Rows per page:
            </span>
            <select
              value={pagination.pageSize}
              onChange={(e) =>
                setPagination({
                  pageIndex: 0,
                  pageSize: Number(e.target.value),
                })
              }
              className="h-7 rounded border border-border bg-background px-2 text-xs"
            >
              {[25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              Page {pagination.pageIndex + 1} of {table.getPageCount() || 1}
            </span>
            <button
              onClick={() => table.setPageIndex(0)}
              disabled={!table.getCanPreviousPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronsLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <button
              onClick={() => table.setPageIndex(table.getPageCount() - 1)}
              disabled={!table.getCanNextPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronsRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
