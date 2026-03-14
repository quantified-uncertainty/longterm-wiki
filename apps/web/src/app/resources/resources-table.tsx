"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type {
  ColumnDef,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";
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
  Columns3,
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

export interface ResourceRow {
  id: string;
  title: string;
  url: string;
  type: string;
  publicationName: string | null;
  credibility: number | null;
  citingPageCount: number;
  tags: string[];
  publishedDate: string | null;
}

const RESOURCE_TYPE_COLORS: Record<string, string> = {
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

function makeColumns(): ColumnDef<ResourceRow>[] {
  return [
    {
      accessorKey: "title",
      header: ({ column }) => (
        <SortableHeader column={column}>Title</SortableHeader>
      ),
      cell: ({ row }) => (
        <Link
          href={`/resources/${row.original.id}`}
          className="text-primary hover:underline text-xs font-medium max-w-[300px] truncate block"
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
        const color = RESOURCE_TYPE_COLORS[t] || DEFAULT_TYPE_COLOR;
        return (
          <span className={`text-xs px-1.5 py-0.5 rounded ${color}`}>{t}</span>
        );
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "publicationName",
      header: ({ column }) => (
        <SortableHeader column={column}>Publication</SortableHeader>
      ),
      cell: ({ row }) => {
        const p = row.original.publicationName;
        if (!p)
          return (
            <span className="text-muted-foreground/40 text-xs">-</span>
          );
        return (
          <span
            className="text-xs text-muted-foreground italic max-w-[140px] truncate block"
            title={p}
          >
            {p}
          </span>
        );
      },
      sortUndefined: "last",
    },
    {
      accessorKey: "credibility",
      header: ({ column }) => (
        <SortableHeader column={column}>Credibility</SortableHeader>
      ),
      cell: ({ row }) => {
        const c = row.original.credibility;
        if (c == null)
          return (
            <span className="text-muted-foreground/40 text-xs">-</span>
          );
        const color =
          c >= 4
            ? "text-emerald-600"
            : c >= 3
              ? "text-blue-500"
              : c >= 2
                ? "text-amber-600"
                : "text-red-500";
        return (
          <span className={`text-xs font-medium tabular-nums ${color}`}>
            {c}/5
          </span>
        );
      },
      sortUndefined: "last",
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
      accessorKey: "tags",
      header: "Tags",
      cell: ({ row }) => {
        const tags = row.original.tags;
        if (!tags.length)
          return (
            <span className="text-muted-foreground/40 text-xs">-</span>
          );
        const display = tags.slice(0, 3);
        const remaining = tags.length - display.length;
        return (
          <span className="flex flex-wrap gap-0.5 max-w-[160px]">
            {display.map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1 py-px bg-muted rounded text-muted-foreground"
              >
                {tag}
              </span>
            ))}
            {remaining > 0 && (
              <span className="text-[10px] text-muted-foreground/60">
                +{remaining}
              </span>
            )}
          </span>
        );
      },
      filterFn: (row, _columnId, filterValue: string) => {
        return row.original.tags.some((tag) =>
          tag.toLowerCase().includes(filterValue.toLowerCase()),
        );
      },
    },
    {
      accessorKey: "id",
      header: ({ column }) => (
        <SortableHeader column={column}>ID</SortableHeader>
      ),
      cell: ({ row }) => (
        <span
          className="text-xs font-mono text-muted-foreground/60 max-w-[100px] truncate block"
          title={row.original.id}
        >
          {row.original.id}
        </span>
      ),
    },
  ];
}

const INITIAL_COLUMN_VISIBILITY: Record<string, boolean> = {
  id: false,
  tags: false,
};

export function ResourcesTable({ rows }: { rows: ResourceRow[] }) {
  const columns = useMemo(() => makeColumns(), []);

  const [sorting, setSorting] = useState<SortingState>([
    { id: "citingPageCount", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] =
    useState<VisibilityState>(INITIAL_COLUMN_VISIBILITY);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });
  const [typeFilter, setTypeFilter] = useState<string>("");

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      counts.set(r.type, (counts.get(r.type) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const filteredData = useMemo(() => {
    let data = rows;
    if (typeFilter) data = data.filter((r) => r.type === typeFilter);
    return data;
  }, [rows, typeFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    onColumnVisibilityChange: setColumnVisibility,
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: setPagination,
    state: {
      sorting,
      globalFilter,
      columnVisibility,
      pagination,
    },
  });

  const filtered = table.getFilteredRowModel().rows.length;
  const total = rows.length;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Search resources"
            placeholder="Search resources..."
            value={globalFilter ?? ""}
            onChange={(e) => {
              setGlobalFilter(e.target.value);
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            className="h-9 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>

        {/* Type filter */}
        <select
          aria-label="Filter by resource type"
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setPagination((p) => ({ ...p, pageIndex: 0 }));
          }}
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm shadow-sm"
        >
          <option value="">All types</option>
          {types.map(([type, count]) => (
            <option key={type} value={type}>
              {type} ({count})
            </option>
          ))}
        </select>

        {/* Column picker */}
        <div className="relative">
          <button
            onClick={() => setShowColumnPicker((v) => !v)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-border rounded-md bg-background text-muted-foreground hover:bg-muted transition-colors"
          >
            <Columns3 className="h-3.5 w-3.5" />
            Columns
          </button>
          {showColumnPicker && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-2 min-w-[180px]">
              {table.getAllLeafColumns().map((col) => (
                <label
                  key={col.id}
                  className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-muted rounded cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={col.getIsVisible()}
                    onChange={col.getToggleVisibilityHandler()}
                    className="rounded"
                  />
                  {typeof col.columnDef.header === "string"
                    ? col.columnDef.header
                    : col.id.charAt(0).toUpperCase() +
                      col.id.slice(1).replace(/([A-Z])/g, " $1")}
                </label>
              ))}
            </div>
          )}
        </div>

        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filtered === total
            ? `${total.toLocaleString()} resources`
            : `${filtered.toLocaleString()} of ${total.toLocaleString()} resources`}
        </span>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border/60 shadow-sm max-h-[70vh] overflow-auto">
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
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="py-1.5">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  No resources match your search.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Rows per page:</span>
          <select
            value={pagination.pageSize}
            onChange={(e) =>
              setPagination({ pageIndex: 0, pageSize: Number(e.target.value) })
            }
            className="h-7 rounded border border-border bg-background px-2 text-xs"
          >
            {[25, 50, 100, 200].map((size) => (
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
    </div>
  );
}
