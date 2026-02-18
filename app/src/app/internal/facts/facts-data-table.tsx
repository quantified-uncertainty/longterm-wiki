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

export interface FactDataRow {
  key: string;
  entity: string;
  factId: string;
  value?: string;
  numeric?: number;
  low?: number;
  high?: number;
  asOf?: string;
  source?: string;
  sourceResource?: string;
  sourceTitle?: string;
  sourcePublication?: string;
  sourceCredibility?: number;
  note?: string;
  computed?: boolean;
  compute?: string;
  measure?: string;
  subject?: string;
  format?: string;
  formatDivisor?: number;
  noCompute?: boolean;
}

interface FactMeasureDef {
  id: string;
  label: string;
  unit: string;
  category: string;
  direction?: "higher" | "lower";
}

function formatCompact(n: number): string {
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

function makeColumns(
  entityHrefs: Record<string, string>,
  factMeasures: Record<string, FactMeasureDef>,
): ColumnDef<FactDataRow>[] {
  return [
    {
      accessorKey: "entity",
      header: ({ column }) => <SortableHeader column={column}>Entity</SortableHeader>,
      cell: ({ row }) => (
        <Link
          href={entityHrefs[row.original.entity] || `/wiki/${row.original.entity}`}
          className="text-primary hover:underline text-xs font-medium"
        >
          {row.original.entity}
        </Link>
      ),
      filterFn: "includesString",
    },
    {
      accessorKey: "factId",
      header: ({ column }) => <SortableHeader column={column}>Fact ID</SortableHeader>,
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.factId}</span>
      ),
      filterFn: "includesString",
    },
    {
      accessorKey: "measure",
      header: ({ column }) => <SortableHeader column={column}>Measure</SortableHeader>,
      cell: ({ row }) => {
        const m = row.original.measure;
        if (!m) return <span className="text-muted-foreground/40 text-xs">-</span>;
        const def = factMeasures[m];
        return (
          <span
            className="text-xs px-1.5 py-0.5 bg-violet-100 text-violet-700 rounded dark:bg-violet-900 dark:text-violet-300"
            title={def?.category}
          >
            {def?.label || m}
          </span>
        );
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "value",
      header: ({ column }) => <SortableHeader column={column}>Value</SortableHeader>,
      cell: ({ row }) => {
        const f = row.original;
        return (
          <span className="text-xs">
            {f.value || (f.numeric != null ? String(f.numeric) : "-")}
          </span>
        );
      },
    },
    {
      accessorKey: "numeric",
      header: ({ column }) => <SortableHeader column={column}>Numeric</SortableHeader>,
      cell: ({ row }) => {
        const n = row.original.numeric;
        if (n == null) return <span className="text-muted-foreground/40 text-xs">-</span>;
        return <span className="text-xs tabular-nums">{formatCompact(n)}</span>;
      },
      sortUndefined: "last",
    },
    {
      id: "range",
      header: "Range",
      cell: ({ row }) => {
        const { low, high } = row.original;
        if (low == null || high == null) return <span className="text-muted-foreground/40 text-xs">-</span>;
        return (
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatCompact(low)} &ndash; {formatCompact(high)}
          </span>
        );
      },
    },
    {
      accessorKey: "asOf",
      header: ({ column }) => <SortableHeader column={column}>As Of</SortableHeader>,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground font-mono">
          {row.original.asOf || "-"}
        </span>
      ),
      sortUndefined: "last",
    },
    {
      id: "source",
      accessorFn: (row) => row.sourcePublication || row.sourceTitle || row.source || "",
      header: ({ column }) => <SortableHeader column={column}>Source</SortableHeader>,
      cell: ({ row }) => {
        const f = row.original;
        if (f.sourceTitle) {
          return (
            <span className="flex items-center gap-1 text-xs max-w-[180px]">
              <a
                href={f.source}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline truncate"
                title={f.sourceTitle}
              >
                {f.sourcePublication || f.sourceTitle}
              </a>
              {f.sourceCredibility != null && (
                <span
                  className={`inline-block px-1 py-px rounded text-[9px] font-medium shrink-0 ${
                    f.sourceCredibility >= 4
                      ? "bg-green-500/15 text-green-600 dark:text-green-400"
                      : f.sourceCredibility >= 3
                        ? "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400"
                        : "bg-red-500/15 text-red-600 dark:text-red-400"
                  }`}
                >
                  {f.sourceCredibility}/5
                </span>
              )}
            </span>
          );
        }
        if (f.source) {
          try {
            return (
              <a
                href={f.source}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline text-xs"
              >
                {new URL(f.source).hostname.replace("www.", "")}
              </a>
            );
          } catch {
            return <span className="text-xs text-muted-foreground truncate">{f.source}</span>;
          }
        }
        return <span className="text-muted-foreground/40 text-xs">-</span>;
      },
      filterFn: "includesString",
    },
    {
      id: "type",
      accessorFn: (row) => (row.computed ? "computed" : "manual"),
      header: ({ column }) => <SortableHeader column={column}>Type</SortableHeader>,
      cell: ({ row }) => {
        if (row.original.computed) {
          return (
            <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded dark:bg-blue-900 dark:text-blue-300">
              computed
            </span>
          );
        }
        return (
          <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded dark:bg-green-900 dark:text-green-300">
            manual
          </span>
        );
      },
    },
    {
      accessorKey: "note",
      header: "Note",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground max-w-[200px] truncate block" title={row.original.note}>
          {row.original.note || "-"}
        </span>
      ),
    },
    {
      accessorKey: "compute",
      header: "Compute Expr",
      cell: ({ row }) => {
        const c = row.original.compute;
        if (!c) return <span className="text-muted-foreground/40 text-xs">-</span>;
        return (
          <span className="font-mono text-[10px] text-muted-foreground max-w-[180px] truncate block" title={c}>
            {c}
          </span>
        );
      },
    },
    {
      accessorKey: "subject",
      header: "Subject",
      cell: ({ row }) => {
        const s = row.original.subject;
        if (!s) return <span className="text-muted-foreground/40 text-xs">-</span>;
        return <span className="text-xs text-muted-foreground">{s}</span>;
      },
    },
    {
      accessorKey: "sourceResource",
      header: "Resource ID",
      cell: ({ row }) => {
        const sr = row.original.sourceResource;
        if (!sr) return <span className="text-muted-foreground/40 text-xs">-</span>;
        return <span className="font-mono text-[10px] text-muted-foreground">{sr}</span>;
      },
    },
  ];
}

// Default visible columns (hide less commonly needed ones)
const DEFAULT_HIDDEN: Record<string, boolean> = {
  compute: false,
  subject: false,
  sourceResource: false,
  range: false,
};

export function FactsDataTable({
  facts,
  entityHrefs,
  factMeasures,
}: {
  facts: FactDataRow[];
  entityHrefs: Record<string, string>;
  factMeasures: Record<string, FactMeasureDef>;
}) {
  const columns = useMemo(() => makeColumns(entityHrefs, factMeasures), [entityHrefs, factMeasures]);

  const [sorting, setSorting] = useState<SortingState>([{ id: "entity", desc: false }]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(DEFAULT_HIDDEN);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });

  const table = useReactTable({
    data: facts,
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
  const total = facts.length;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search all facts..."
            value={globalFilter ?? ""}
            onChange={(e) => {
              setGlobalFilter(e.target.value);
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            className="h-9 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>

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
          {filtered === total ? `${total} facts` : `${filtered} of ${total} facts`}
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
                  No facts match your search.
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
