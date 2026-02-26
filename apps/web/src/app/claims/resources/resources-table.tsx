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
  ExternalLink,
  FileText,
  Globe,
  Landmark,
  BookOpen,
  Mic,
  Headphones,
  Pen,
  ClipboardList,
  Library,
  HardDrive,
  FileSearch,
  CircleDashed,
  FileCheck,
  FileX,
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
  hasReview: boolean;
  hasKeyPoints: boolean;
  fetchStatus: "full" | "metadata-only" | "unfetched";
  authors: string[] | null;
  tags: string[];
}

/** Strip markdown bold markers from titles */
function cleanTitle(title: string): string {
  return title.replace(/\*\*/g, "");
}

/** Extract display domain from URL */
function getDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Lucide icon component for each resource type */
function TypeIcon({
  type,
  className = "h-3.5 w-3.5",
}: {
  type: string;
  className?: string;
}) {
  const iconMap: Record<string, React.ElementType> = {
    paper: FileText,
    blog: Pen,
    report: ClipboardList,
    book: BookOpen,
    talk: Mic,
    podcast: Headphones,
    government: Landmark,
    reference: Library,
    web: Globe,
  };
  const Icon = iconMap[type] || Globe;
  return <Icon className={className} />;
}

const TYPE_COLORS: Record<string, string> = {
  paper: "text-blue-600 dark:text-blue-400",
  blog: "text-purple-600 dark:text-purple-400",
  report: "text-teal-600 dark:text-teal-400",
  book: "text-amber-600 dark:text-amber-400",
  web: "text-gray-500 dark:text-gray-400",
  government: "text-indigo-600 dark:text-indigo-400",
  talk: "text-orange-600 dark:text-orange-400",
  podcast: "text-pink-600 dark:text-pink-400",
  reference: "text-cyan-600 dark:text-cyan-400",
};

const TYPE_BADGE_COLORS: Record<string, string> = {
  paper: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  blog: "bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  report: "bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
  book: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  web: "bg-gray-50 text-gray-600 dark:bg-gray-800/50 dark:text-gray-300",
  government:
    "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  talk: "bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  podcast:
    "bg-pink-50 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300",
  reference:
    "bg-cyan-50 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
};

const DEFAULT_BADGE_COLOR =
  "bg-gray-50 text-gray-600 dark:bg-gray-800/50 dark:text-gray-300";

function makeColumns(): ColumnDef<ResourceRow>[] {
  return [
    {
      accessorKey: "title",
      header: ({ column }) => (
        <SortableHeader column={column}>Title</SortableHeader>
      ),
      cell: ({ row }) => {
        const r = row.original;
        const domain = getDomain(r.url);
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Link
                href={`/source/${r.id}`}
                className="text-primary hover:underline text-sm font-medium truncate max-w-[320px]"
                title={cleanTitle(r.title)}
              >
                {cleanTitle(r.title)}
              </Link>
              <a
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-muted-foreground/40 hover:text-primary transition-colors"
                title={`Open ${domain ?? "source"}`}
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            {domain && (
              <span className="text-[11px] text-muted-foreground/60">
                {domain}
              </span>
            )}
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
        const color = TYPE_COLORS[t] || "text-gray-500";
        const badge = TYPE_BADGE_COLORS[t] || DEFAULT_BADGE_COLOR;
        return (
          <span
            className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded ${badge}`}
          >
            <TypeIcon type={t} className={`h-3 w-3 ${color}`} />
            <span className="capitalize">{t}</span>
          </span>
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
            <span className="text-muted-foreground/30 text-xs">&mdash;</span>
          );
        return (
          <span
            className="text-xs text-muted-foreground truncate block max-w-[140px]"
            title={p}
          >
            {p}
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
      cell: ({ row }) => {
        const count = row.original.citingPageCount;
        return (
          <span
            className={`text-xs tabular-nums ${count > 0 ? "font-medium" : "text-muted-foreground/30"}`}
          >
            {count || "\u2014"}
          </span>
        );
      },
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
            <span className="text-muted-foreground/30 text-xs">&mdash;</span>
          );
        return <CredibilityBadge level={c} size="sm" />;
      },
      sortUndefined: "last",
    },
    {
      id: "content",
      header: "Content",
      cell: ({ row }) => {
        const r = row.original;
        const items: { key: string; label: string; present: boolean; Icon: React.ElementType }[] = [
          { key: "S", label: "Summary", present: r.hasSummary, Icon: FileCheck },
          { key: "R", label: "Review", present: r.hasReview, Icon: FileSearch },
          { key: "K", label: "Key Points", present: r.hasKeyPoints, Icon: ClipboardList },
        ];
        return (
          <span className="flex gap-0.5">
            {items.map(({ key, label, present, Icon }) => (
              <span
                key={key}
                className={`flex items-center justify-center w-5 h-5 rounded ${
                  present
                    ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                    : "bg-muted/50 text-muted-foreground/20"
                }`}
                title={`${label}: ${present ? "Yes" : "No"}`}
              >
                <Icon className="h-3 w-3" />
              </span>
            ))}
          </span>
        );
      },
    },
    {
      accessorKey: "fetchStatus",
      header: ({ column }) => (
        <SortableHeader column={column}>Snapshot</SortableHeader>
      ),
      cell: ({ row }) => {
        const status = row.original.fetchStatus;
        if (status === "full")
          return (
            <span
              className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400"
              title="Full text saved"
            >
              <HardDrive className="h-3 w-3" />
              Saved
            </span>
          );
        if (status === "metadata-only")
          return (
            <span
              className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400"
              title="Metadata only"
            >
              <CircleDashed className="h-3 w-3" />
              Meta
            </span>
          );
        return (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/40"
            title="Not fetched"
          >
            <FileX className="h-3 w-3" />
            No
          </span>
        );
      },
      filterFn: "includesString",
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
            <span className="text-muted-foreground/30 text-xs">&mdash;</span>
          );
        return (
          <span className="text-xs text-muted-foreground tabular-nums">
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
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [snapshotFilter, setSnapshotFilter] = useState<string>("");

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
    if (snapshotFilter)
      data = data.filter((r) => r.fetchStatus === snapshotFilter);
    return data;
  }, [resources, typeFilter, snapshotFilter]);

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
  const total = resources.length;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              placeholder="Search title, publication, URL..."
              value={globalFilter ?? ""}
              onChange={(e) => {
                setGlobalFilter(e.target.value);
                setPagination((p) => ({ ...p, pageIndex: 0 }));
              }}
              className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Snapshot filter */}
          <select
            value={snapshotFilter}
            onChange={(e) => {
              setSnapshotFilter(e.target.value);
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs"
          >
            <option value="">All snapshots</option>
            <option value="full">Saved</option>
            <option value="metadata-only">Metadata only</option>
            <option value="unfetched">Not fetched</option>
          </select>

          <span className="text-[11px] text-muted-foreground tabular-nums ml-auto">
            {filtered === total
              ? `${total.toLocaleString()} resources`
              : `${filtered.toLocaleString()} of ${total.toLocaleString()}`}
          </span>
        </div>

        {/* Type filter pills */}
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => {
              setTypeFilter("");
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
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
              className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-colors capitalize ${
                typeFilter === type
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background text-muted-foreground border-border hover:border-foreground/30"
              }`}
            >
              <TypeIcon
                type={type}
                className={`h-3 w-3 ${typeFilter === type ? "" : TYPE_COLORS[type] || ""}`}
              />
              {type} ({count.toLocaleString()})
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-md border border-border/60 shadow-sm">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow
                key={headerGroup.id}
                className="hover:bg-transparent border-b border-border/60"
              >
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="whitespace-nowrap text-xs h-8"
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
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} className="group">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="py-1.5 text-xs">
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
                  className="h-20 text-center text-muted-foreground text-sm"
                >
                  No resources match your search.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            Rows per page:
          </span>
          <select
            value={pagination.pageSize}
            onChange={(e) =>
              setPagination({ pageIndex: 0, pageSize: Number(e.target.value) })
            }
            className="h-6 rounded border border-border bg-background px-1.5 text-[11px]"
          >
            {[25, 50, 100, 200].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground tabular-nums mr-1">
            {pagination.pageIndex + 1} / {table.getPageCount() || 1}
          </span>
          <button
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
            className="p-0.5 rounded hover:bg-muted disabled:opacity-20 disabled:cursor-not-allowed"
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="p-0.5 rounded hover:bg-muted disabled:opacity-20 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="p-0.5 rounded hover:bg-muted disabled:opacity-20 disabled:cursor-not-allowed"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!table.getCanNextPage()}
            className="p-0.5 rounded hover:bg-muted disabled:opacity-20 disabled:cursor-not-allowed"
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
