"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { safeHref } from "@/lib/format-compact";
import type { OrgResourceRow, AuthorRef } from "./org-data";

const TYPE_COLORS: Record<string, string> = {
  paper: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  blog: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  report: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  book: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  web: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  government: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  talk: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  podcast: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
};

const DEFAULT_COLOR = "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";

/** Compute which optional columns have enough data to be worth showing. */
function computeColumnVisibility(resources: OrgResourceRow[]) {
  const total = resources.length || 1;
  const withDate = resources.filter((r) => r.publishedDate).length;
  const withPub = resources.filter((r) => r.publicationName).length;
  const withCred = resources.filter((r) => r.credibility != null).length;
  return {
    showDate: withDate / total >= 0.2,
    showPublication: withPub / total >= 0.15,
    showCredibility: withCred / total >= 0.15,
  };
}

function makeColumns(opts: {
  showDate: boolean;
  showPublication: boolean;
  showCredibility: boolean;
}): ColumnDef<OrgResourceRow>[] {
  const cols: ColumnDef<OrgResourceRow>[] = [
    {
      accessorKey: "title",
      header: ({ column }) => (
        <SortableHeader column={column}>Title</SortableHeader>
      ),
      cell: ({ row }) => (
        <div className="min-w-[200px] max-w-[400px]">
          <Link
            href={`/resources/${row.original.id}`}
            className="text-primary hover:underline text-xs font-medium line-clamp-2"
            title={row.original.title}
          >
            {row.original.title}
          </Link>
          {row.original.authors.length > 0 && (
            <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
              {row.original.authors.slice(0, 3).map((a, i) => (
                <span key={i}>
                  {i > 0 && ", "}
                  {a.href ? (
                    <Link href={a.href} className="hover:text-primary hover:underline">
                      {a.name}
                    </Link>
                  ) : (
                    a.name
                  )}
                </span>
              ))}
              {row.original.authors.length > 3 &&
                ` +${row.original.authors.length - 3}`}
            </div>
          )}
        </div>
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
        const color = TYPE_COLORS[t] || DEFAULT_COLOR;
        return (
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap ${color}`}>
            {t}
          </span>
        );
      },
    },
  ];

  if (opts.showPublication) {
    cols.push({
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
    });
  }

  if (opts.showDate) {
    cols.push({
      accessorKey: "publishedDate",
      header: ({ column }) => (
        <SortableHeader column={column}>Published</SortableHeader>
      ),
      cell: ({ row }) => {
        const d = row.original.publishedDate;
        if (!d) return <span className="text-muted-foreground/40 text-xs">-</span>;
        return (
          <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
            {d.slice(0, 10)}
          </span>
        );
      },
      sortUndefined: "last",
    });
  }

  if (opts.showCredibility) {
    cols.push({
      accessorKey: "credibility",
      header: ({ column }) => (
        <SortableHeader column={column}>Cred.</SortableHeader>
      ),
      cell: ({ row }) => {
        const c = row.original.credibility;
        if (c == null) return <span className="text-muted-foreground/40 text-xs">-</span>;
        const color =
          c >= 4 ? "text-emerald-600"
            : c >= 3 ? "text-blue-500"
              : c >= 2 ? "text-amber-600"
                : "text-red-500";
        return (
          <span className={`text-xs font-medium tabular-nums ${color}`}>
            {c}/5
          </span>
        );
      },
      sortUndefined: "last",
    });
  }

  cols.push(
    {
      accessorKey: "citingPageCount",
      header: ({ column }) => (
        <SortableHeader column={column}>Pages</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="text-xs tabular-nums text-muted-foreground">
          {row.original.citingPageCount || "-"}
        </span>
      ),
    },
    {
      id: "link",
      header: "",
      cell: ({ row }) => (
        <a
          href={safeHref(row.original.url)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:text-primary/80"
          title={row.original.url}
        >
          &#8599;
        </a>
      ),
      enableSorting: false,
    },
  );

  return cols;
}

export function OrgResourcesSection({
  resources,
  title,
  emptyMessage,
}: {
  resources: OrgResourceRow[];
  title: string;
  emptyMessage: string;
}) {
  if (resources.length === 0) {
    return (
      <section>
        <h3 className="text-lg font-bold tracking-tight mb-2">{title}</h3>
        <p className="text-sm text-muted-foreground py-4">{emptyMessage}</p>
      </section>
    );
  }

  return (
    <section>
      <OrgResourcesTable resources={resources} title={title} />
    </section>
  );
}

function OrgResourcesTable({
  resources,
  title,
}: {
  resources: OrgResourceRow[];
  title: string;
}) {
  const colVis = useMemo(() => computeColumnVisibility(resources), [resources]);
  const columns = useMemo(() => makeColumns(colVis), [colVis]);

  const [sorting, setSorting] = useState<SortingState>(
    colVis.showDate
      ? [{ id: "publishedDate", desc: true }]
      : [{ id: "title", desc: false }],
  );
  const [globalFilter, setGlobalFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of resources) {
      counts.set(r.type, (counts.get(r.type) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [resources]);

  const filteredData = useMemo(() => {
    let data = resources;
    if (typeFilter) data = data.filter((r) => r.type === typeFilter);
    return data;
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
    getPaginationRowModel: getPaginationRowModel(),
    onPaginationChange: setPagination,
    state: { sorting, globalFilter, pagination },
  });

  const filtered = table.getFilteredRowModel().rows.length;
  const total = resources.length;

  return (
    <div className="space-y-3">
      {/* Header + toolbar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-lg font-bold tracking-tight">
          {title}{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({filtered === total ? total : `${filtered} of ${total}`})
          </span>
        </h3>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search..."
            value={globalFilter ?? ""}
            onChange={(e) => {
              setGlobalFilter(e.target.value);
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            className="h-8 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>

        {types.length > 1 && (
          <select
            value={typeFilter}
            onChange={(e) => {
              setTypeFilter(e.target.value);
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            className="h-8 rounded-lg border border-border bg-background px-2 text-xs shadow-sm"
          >
            <option value="">All types</option>
            {types.map(([type, count]) => (
              <option key={type} value={type}>
                {type} ({count})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Table */}
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
                <TableCell colSpan={columns.length} className="h-16 text-center text-muted-foreground">
                  No resources match your filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between px-1">
          <select
            value={pagination.pageSize}
            onChange={(e) =>
              setPagination({ pageIndex: 0, pageSize: Number(e.target.value) })
            }
            className="h-7 rounded border border-border bg-background px-2 text-xs"
          >
            {[25, 50, 100].map((size) => (
              <option key={size} value={size}>{size} per page</option>
            ))}
          </select>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              Page {pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="p-1 rounded hover:bg-muted disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
