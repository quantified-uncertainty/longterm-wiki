"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type {
  ColumnDef,
  SortingState,
} from "@tanstack/react-table";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search } from "lucide-react";
import { SortableHeader } from "@/components/ui/sortable-header";
import { CredibilityBadge } from "@/components/wiki/CredibilityBadge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface PublicationDataRow {
  id: string;
  name: string;
  type: string;
  credibility: number | null;
  peerReviewed: boolean;
  resourceCount: number;
  pageCount: number;
}

const TYPE_COLORS: Record<string, string> = {
  academic_journal:
    "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  preprint_server:
    "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
  think_tank:
    "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300",
  company_blog:
    "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  government:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  encyclopedia:
    "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  blog_platform:
    "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  news: "bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300",
  organization:
    "bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300",
  academic: "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-300",
  consulting:
    "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300",
  academic_search:
    "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300",
  code_repository:
    "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  marketplace:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
};

const DEFAULT_TYPE_COLOR =
  "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";

function formatType(type: string): string {
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function makeColumns(): ColumnDef<PublicationDataRow>[] {
  return [
    {
      accessorKey: "name",
      header: ({ column }) => (
        <SortableHeader column={column}>Name</SortableHeader>
      ),
      cell: ({ row }) => (
        <Link
          href={`/kb/publications/${row.original.id}`}
          className="text-primary hover:underline text-xs font-medium max-w-[250px] truncate block"
          title={row.original.name}
        >
          {row.original.name}
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
          <span className={`text-xs px-1.5 py-0.5 rounded ${color}`}>
            {formatType(t)}
          </span>
        );
      },
      filterFn: "includesString",
    },
    {
      accessorKey: "credibility",
      header: ({ column }) => (
        <SortableHeader column={column}>Credibility</SortableHeader>
      ),
      cell: ({ row }) => {
        const c = row.original.credibility;
        if (c == null) return <span className="text-muted-foreground/40 text-xs">-</span>;
        return <CredibilityBadge level={c} size="sm" showLabel />;
      },
      sortUndefined: "last",
    },
    {
      accessorKey: "peerReviewed",
      header: ({ column }) => (
        <SortableHeader column={column}>Peer-Reviewed</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.peerReviewed ? "Yes" : "-"}
        </span>
      ),
    },
    {
      accessorKey: "resourceCount",
      header: ({ column }) => (
        <SortableHeader column={column}>Resources</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="text-xs tabular-nums text-muted-foreground">
          {row.original.resourceCount}
        </span>
      ),
    },
    {
      accessorKey: "pageCount",
      header: ({ column }) => (
        <SortableHeader column={column}>Pages</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="text-xs tabular-nums text-muted-foreground">
          {row.original.pageCount}
        </span>
      ),
    },
  ];
}

export function KBPublicationsTable({
  publications,
}: {
  publications: PublicationDataRow[];
}) {
  const columns = useMemo(() => makeColumns(), []);

  const [sorting, setSorting] = useState<SortingState>([
    { id: "resourceCount", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [credFilter, setCredFilter] = useState<string>("");

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of publications) {
      counts.set(p.type, (counts.get(p.type) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [publications]);

  const filteredData = useMemo(() => {
    let data = publications;
    if (typeFilter) data = data.filter((p) => p.type === typeFilter);
    if (credFilter)
      data = data.filter((p) => p.credibility === Number(credFilter));
    return data;
  }, [publications, typeFilter, credFilter]);

  const table = useReactTable({
    data: filteredData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    state: {
      sorting,
      globalFilter,
    },
  });

  const filtered = table.getFilteredRowModel().rows.length;
  const total = publications.length;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search publications..."
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>

        {/* Type filter */}
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm shadow-sm"
        >
          <option value="">All types</option>
          {types.map(([type, count]) => (
            <option key={type} value={type}>
              {formatType(type)} ({count})
            </option>
          ))}
        </select>

        {/* Credibility filter */}
        <select
          value={credFilter}
          onChange={(e) => setCredFilter(e.target.value)}
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm shadow-sm"
        >
          <option value="">All credibility</option>
          {[5, 4, 3, 2, 1].map((level) => {
            const count = publications.filter(
              (p) => p.credibility === level
            ).length;
            const labels: Record<number, string> = {
              5: "Gold",
              4: "High",
              3: "Good",
              2: "Mixed",
              1: "Low",
            };
            return (
              <option key={level} value={level}>
                {"*".repeat(level)} {labels[level]} ({count})
              </option>
            );
          })}
        </select>

        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filtered === total
            ? `${total} publications`
            : `${filtered} of ${total} publications`}
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
                  No publications match your search.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
