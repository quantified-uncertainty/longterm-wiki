"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { ColumnDef, ColumnFiltersState, SortingState, VisibilityState } from "@tanstack/react-table";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Columns3 } from "lucide-react";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface EntityDataRow {
  id: string;
  numericId?: string;
  type: string;
  title: string;
  description?: string;
  status?: string;
  tags: string[];
  relatedCount: number;
  hasPage: boolean;
  lastUpdated?: string;
  href: string;
}

const TYPE_COLORS: Record<string, string> = {
  risk: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  person: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  organization: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  approach: "bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300",
  concept: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  model: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  policy: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300",
  event: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  capability: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
  metric: "bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300",
};

const DEFAULT_TYPE_COLOR = "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";

function makeColumns(): ColumnDef<EntityDataRow>[] {
  return [
    {
      accessorKey: "id",
      header: ({ column }) => <SortableHeader column={column}>ID</SortableHeader>,
      cell: ({ row }) => (
        <Link
          href={row.original.href}
          className="text-primary hover:underline text-xs font-mono font-medium"
        >
          {row.original.id}
        </Link>
      ),
      filterFn: "includesString",
    },
    {
      accessorKey: "numericId",
      header: ({ column }) => <SortableHeader column={column}>Numeric ID</SortableHeader>,
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.original.numericId || "-"}
        </span>
      ),
      sortUndefined: "last",
    },
    {
      accessorKey: "type",
      header: ({ column }) => <SortableHeader column={column}>Type</SortableHeader>,
      cell: ({ row }) => {
        const t = row.original.type;
        const color = TYPE_COLORS[t] || DEFAULT_TYPE_COLOR;
        return (
          <span className={`text-xs px-1.5 py-0.5 rounded ${color}`}>
            {t}
          </span>
        );
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "title",
      header: ({ column }) => <SortableHeader column={column}>Title</SortableHeader>,
      cell: ({ row }) => (
        <Link
          href={row.original.href}
          className="text-primary hover:underline text-xs font-medium"
        >
          {row.original.title}
        </Link>
      ),
      filterFn: "includesString",
    },
    {
      accessorKey: "status",
      header: ({ column }) => <SortableHeader column={column}>Status</SortableHeader>,
      cell: ({ row }) => {
        const s = row.original.status;
        if (!s) return <span className="text-muted-foreground/40 text-xs">-</span>;
        return <span className="text-xs text-muted-foreground">{s}</span>;
      },
      sortUndefined: "last",
    },
    {
      accessorKey: "tags",
      header: "Tags",
      cell: ({ row }) => {
        const tags = row.original.tags;
        if (!tags.length) return <span className="text-muted-foreground/40 text-xs">-</span>;
        const display = tags.slice(0, 3);
        const remaining = tags.length - display.length;
        return (
          <span className="flex flex-wrap gap-0.5 max-w-[200px]">
            {display.map((tag) => (
              <span key={tag} className="text-[10px] px-1 py-px bg-muted rounded text-muted-foreground">
                {tag}
              </span>
            ))}
            {remaining > 0 && (
              <span className="text-[10px] text-muted-foreground/60">+{remaining}</span>
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
      accessorKey: "relatedCount",
      header: ({ column }) => <SortableHeader column={column}>Related</SortableHeader>,
      cell: ({ row }) => (
        <span className="text-xs tabular-nums text-muted-foreground">
          {row.original.relatedCount}
        </span>
      ),
    },
    {
      id: "hasPage",
      accessorFn: (row) => (row.hasPage ? "yes" : "no"),
      header: ({ column }) => <SortableHeader column={column}>Page</SortableHeader>,
      cell: ({ row }) => {
        if (row.original.hasPage) {
          return (
            <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded dark:bg-green-900 dark:text-green-300">
              yes
            </span>
          );
        }
        return (
          <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded dark:bg-gray-800 dark:text-gray-400">
            no
          </span>
        );
      },
    },
    {
      accessorKey: "lastUpdated",
      header: ({ column }) => <SortableHeader column={column}>Last Updated</SortableHeader>,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground font-mono">
          {row.original.lastUpdated || "-"}
        </span>
      ),
      sortUndefined: "last",
    },
    {
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span
          className="text-xs text-muted-foreground max-w-[250px] truncate block"
          title={row.original.description}
        >
          {row.original.description || "-"}
        </span>
      ),
    },
  ];
}

const DEFAULT_HIDDEN: Record<string, boolean> = {
  description: false,
  status: false,
};

export function EntitiesDataTable({ entities }: { entities: EntityDataRow[] }) {
  const columns = useMemo(() => makeColumns(), []);

  const [sorting, setSorting] = useState<SortingState>([{ id: "title", desc: false }]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(DEFAULT_HIDDEN);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });
  const [typeFilter, setTypeFilter] = useState<string>("");

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entities) {
      counts.set(e.type, (counts.get(e.type) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [entities]);

  const filteredData = useMemo(() => {
    if (!typeFilter) return entities;
    return entities.filter((e) => e.type === typeFilter);
  }, [entities, typeFilter]);

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
  const total = entities.length;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search entities..."
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
                <label key={col.id} className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-muted rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={col.getIsVisible()}
                    onChange={col.getToggleVisibilityHandler()}
                    className="rounded"
                  />
                  {typeof col.columnDef.header === "string"
                    ? col.columnDef.header
                    : col.id.charAt(0).toUpperCase() + col.id.slice(1).replace(/([A-Z])/g, " $1")}
                </label>
              ))}
            </div>
          )}
        </div>

        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filtered === total ? `${total} entities` : `${filtered} of ${total} entities`}
        </span>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border/60 shadow-sm max-h-[70vh] overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-20">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="hover:bg-transparent border-b-2 border-border/60">
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="whitespace-nowrap">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
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
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  No entities match your search.
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
            onChange={(e) => setPagination({ pageIndex: 0, pageSize: Number(e.target.value) })}
            className="h-7 rounded border border-border bg-background px-2 text-xs"
          >
            {[25, 50, 100, 200].map((size) => (
              <option key={size} value={size}>{size}</option>
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
