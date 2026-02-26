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
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ExternalLink,
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

export interface ResourceRow {
  id: string;
  title: string;
  url: string;
  type: string;
  publicationName: string | null;
  credibility: number | null;
  citingPageCount: number;
  publishedDate: string | null;
  hasSummary: boolean;
}

/** Strip markdown bold markers from titles */
function cleanTitle(title: string): string {
  return title.replace(/\*\*/g, "");
}

const TYPE_COLORS: Record<string, string> = {
  paper: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  blog: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  report: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  book: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  web: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  government:
    "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  talk: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  podcast:
    "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
  reference:
    "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
};

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

const DEFAULT_TYPE_COLOR =
  "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";

function makeColumns(): ColumnDef<ResourceRow>[] {
  return [
    {
      accessorKey: "title",
      header: ({ column }) => (
        <SortableHeader column={column}>Resource</SortableHeader>
      ),
      cell: ({ row }) => {
        const r = row.original;
        const icon = getResourceTypeIcon(r.type);
        return (
          <div className="flex items-start gap-2 min-w-0">
            <span className="text-sm shrink-0 mt-0.5" title={r.type}>
              {icon}
            </span>
            <div className="min-w-0">
              <Link
                href={`/source/${r.id}`}
                className="text-primary hover:underline text-sm font-medium block truncate max-w-[340px]"
                title={cleanTitle(r.title)}
              >
                {cleanTitle(r.title)}
              </Link>
              {r.publicationName && (
                <span className="text-xs text-muted-foreground block truncate max-w-[300px]">
                  {r.publicationName}
                </span>
              )}
            </div>
            <a
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground mt-0.5"
              title="Open source URL"
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        );
      },
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
          <span className={`text-xs px-1.5 py-0.5 rounded ${color} capitalize`}>
            {TYPE_LABELS[t] ?? t}
          </span>
        );
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "citingPageCount",
      header: ({ column }) => (
        <SortableHeader column={column}>Pages</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="text-sm tabular-nums font-medium">
          {row.original.citingPageCount}
        </span>
      ),
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
            <span className="text-muted-foreground/40 text-xs">&mdash;</span>
          );
        return <CredibilityBadge level={c} size="sm" />;
      },
      sortUndefined: "last",
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
            <span className="text-muted-foreground/40 text-xs">&mdash;</span>
          );
        return (
          <span className="text-xs text-muted-foreground">
            {d.length > 7 ? d.slice(0, 10) : d}
          </span>
        );
      },
      sortUndefined: "last",
    },
  ];
}

export function ResourcesTable({ resources }: { resources: ResourceRow[] }) {
  const columns = useMemo(() => makeColumns(), []);

  const [sorting, setSorting] = useState<SortingState>([
    { id: "citingPageCount", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility] = useState<VisibilityState>({});
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });
  const [typeFilter, setTypeFilter] = useState<string>("");

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of resources) {
      counts.set(r.type, (counts.get(r.type) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [resources]);

  const filteredData = useMemo(() => {
    if (!typeFilter) return resources;
    return resources.filter((r) => r.type === typeFilter);
  }, [resources, typeFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    onColumnVisibilityChange: () => {},
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
  const total = resources.length;

  return (
    <div className="space-y-4">
      {/* Search + type filter pills */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Search resources..."
            value={globalFilter ?? ""}
            onChange={(e) => {
              setGlobalFilter(e.target.value);
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            className="flex-1 max-w-xs px-3 py-1.5 text-sm border rounded-md bg-background"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => {
              setTypeFilter("");
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              !typeFilter
                ? "bg-foreground text-background border-foreground"
                : "bg-background text-muted-foreground border-border hover:border-foreground/30"
            }`}
          >
            All ({total.toLocaleString()})
          </button>
          {types.map(([type, count]) => (
            <button
              key={type}
              onClick={() => {
                setTypeFilter(typeFilter === type ? "" : type);
                setPagination((p) => ({ ...p, pageIndex: 0 }));
              }}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors capitalize ${
                typeFilter === type
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background text-muted-foreground border-border hover:border-foreground/30"
              }`}
            >
              {TYPE_LABELS[type] ?? type} ({count.toLocaleString()})
            </button>
          ))}
        </div>
      </div>

      {/* Result count */}
      {filtered !== total && (
        <p className="text-xs text-muted-foreground">
          Showing {filtered.toLocaleString()} of {total.toLocaleString()}{" "}
          resources
        </p>
      )}

      {/* Table */}
      <div className="rounded-lg border border-border/60 shadow-sm">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                key={headerGroup.id}
                className="hover:bg-transparent border-b border-border/60"
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
                    <TableCell key={cell.id} className="py-2">
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
          <span className="text-xs text-muted-foreground tabular-nums">
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