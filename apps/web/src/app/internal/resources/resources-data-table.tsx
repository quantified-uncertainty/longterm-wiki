"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type {
  ColumnDef,
  ColumnFiltersState,
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

export interface ResourceDataRow {
  id: string;
  title: string;
  url: string;
  type: string;
  fetchStatus: "full" | "metadata-only" | "unfetched";
  fetchedAt: string | null;
  hasSummary: boolean;
  hasReview: boolean;
  hasKeyPoints: boolean;
  publicationName: string | null;
  credibility: number | null;
  citingPageCount: number;
  tags: string[];
  publishedDate: string | null;
}

const FETCH_STATUS_STYLES: Record<
  string,
  { label: string; bg: string; text: string }
> = {
  full: {
    label: "Full text",
    bg: "bg-emerald-100 dark:bg-emerald-900/40",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  "metadata-only": {
    label: "Metadata",
    bg: "bg-amber-100 dark:bg-amber-900/40",
    text: "text-amber-700 dark:text-amber-300",
  },
  unfetched: {
    label: "Unfetched",
    bg: "bg-red-100 dark:bg-red-900/40",
    text: "text-red-700 dark:text-red-300",
  },
};

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

function makeColumns(): ColumnDef<ResourceDataRow>[] {
  return [
    {
      accessorKey: "title",
      header: ({ column }) => (
        <SortableHeader column={column}>Title</SortableHeader>
      ),
      cell: ({ row }) => (
        <Link
          href={`/source/${row.original.id}`}
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
        const color = TYPE_COLORS[t] || DEFAULT_TYPE_COLOR;
        return (
          <span className={`text-xs px-1.5 py-0.5 rounded ${color}`}>{t}</span>
        );
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "fetchStatus",
      header: ({ column }) => (
        <SortableHeader column={column}>Fetch Status</SortableHeader>
      ),
      cell: ({ row }) => {
        const status = row.original.fetchStatus;
        const style = FETCH_STATUS_STYLES[status];
        return (
          <span
            className={`text-xs px-1.5 py-0.5 rounded ${style.bg} ${style.text}`}
          >
            {style.label}
          </span>
        );
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "fetchedAt",
      header: ({ column }) => (
        <SortableHeader column={column}>Fetched</SortableHeader>
      ),
      cell: ({ row }) => {
        const d = row.original.fetchedAt;
        if (!d) return <span className="text-muted-foreground/40 text-xs">-</span>;
        return (
          <span className="text-xs text-muted-foreground font-mono">
            {d.slice(0, 10)}
          </span>
        );
      },
      sortUndefined: "last",
    },
    {
      id: "content",
      header: "Content",
      cell: ({ row }) => {
        const r = row.original;
        const indicators: { label: string; present: boolean }[] = [
          { label: "S", present: r.hasSummary },
          { label: "R", present: r.hasReview },
          { label: "K", present: r.hasKeyPoints },
        ];
        return (
          <span className="flex gap-0.5">
            {indicators.map(({ label, present }) => (
              <span
                key={label}
                className={`text-[10px] w-4 h-4 flex items-center justify-center rounded ${
                  present
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground/30"
                }`}
                title={
                  label === "S"
                    ? "Summary"
                    : label === "R"
                      ? "Review"
                      : "Key Points"
                }
              >
                {label}
              </span>
            ))}
          </span>
        );
      },
    },
    {
      accessorKey: "publicationName",
      header: ({ column }) => (
        <SortableHeader column={column}>Publication</SortableHeader>
      ),
      cell: ({ row }) => {
        const p = row.original.publicationName;
        if (!p) return <span className="text-muted-foreground/40 text-xs">-</span>;
        return (
          <span className="text-xs text-muted-foreground italic max-w-[140px] truncate block" title={p}>
            {p}
          </span>
        );
      },
      sortUndefined: "last",
    },
    {
      accessorKey: "credibility",
      header: ({ column }) => (
        <SortableHeader column={column}>Cred</SortableHeader>
      ),
      cell: ({ row }) => {
        const c = row.original.credibility;
        if (c == null) return <span className="text-muted-foreground/40 text-xs">-</span>;
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
      accessorKey: "tags",
      header: "Tags",
      cell: ({ row }) => {
        const tags = row.original.tags;
        if (!tags.length)
          return <span className="text-muted-foreground/40 text-xs">-</span>;
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
          tag.toLowerCase().includes(filterValue.toLowerCase())
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
        if (!d) return <span className="text-muted-foreground/40 text-xs">-</span>;
        return (
          <span className="text-xs text-muted-foreground font-mono">
            {d.length > 7 ? d.slice(0, 10) : d}
          </span>
        );
      },
      sortUndefined: "last",
    },
    {
      accessorKey: "id",
      header: ({ column }) => (
        <SortableHeader column={column}>ID</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="text-xs font-mono text-muted-foreground/60 max-w-[100px] truncate block" title={row.original.id}>
          {row.original.id}
        </span>
      ),
    },
  ];
}

const DEFAULT_HIDDEN: Record<string, boolean> = {
  id: false,
  tags: false,
  publishedDate: false,
};

export function ResourcesDataTable({
  resources,
}: {
  resources: ResourceDataRow[];
}) {
  const columns = useMemo(() => makeColumns(), []);

  const [sorting, setSorting] = useState<SortingState>([
    { id: "citingPageCount", desc: true },
  ]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] =
    useState<VisibilityState>(DEFAULT_HIDDEN);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of resources) {
      counts.set(r.type, (counts.get(r.type) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [resources]);

  const statuses = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of resources) {
      counts.set(r.fetchStatus, (counts.get(r.fetchStatus) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [resources]);

  const filteredData = useMemo(() => {
    let data = resources;
    if (typeFilter) data = data.filter((r) => r.type === typeFilter);
    if (statusFilter) data = data.filter((r) => r.fetchStatus === statusFilter);
    return data;
  }, [resources, typeFilter, statusFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    onColumnFiltersChange: setColumnFilters,
    getFilteredRowModel: getFilteredRowModel(),
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    onColumnVisibilityChange: setColumnVisibility,
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: setPagination,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnVisibility,
      pagination,
    },
  });

  const filtered = table.getFilteredRowModel().rows.length;
  const total = resources.length;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
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

        {/* Type filter */}
        <select
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

        {/* Status filter */}
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPagination((p) => ({ ...p, pageIndex: 0 }));
          }}
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm shadow-sm"
        >
          <option value="">All statuses</option>
          {statuses.map(([status, count]) => (
            <option key={status} value={status}>
              {FETCH_STATUS_STYLES[status]?.label ?? status} ({count})
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
                          header.getContext()
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
