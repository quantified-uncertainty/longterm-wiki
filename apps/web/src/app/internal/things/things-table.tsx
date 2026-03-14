"use client";

import { useState, useEffect } from "react";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ExternalLink, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThingRow {
  id: string;
  thingType: string;
  title: string;
  entityType: string | null;
  description: string | null;
  sourceUrl: string | null;
  numericId: string | null;
  href?: string;
  isExternal?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function thingTypeBadge(type: string) {
  const colors: Record<string, string> = {
    entity: "bg-blue-100 text-blue-800",
    resource: "bg-purple-100 text-purple-800",
    grant: "bg-green-100 text-green-800",
    benchmark: "bg-pink-100 text-pink-800",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[type] || "bg-gray-100 text-gray-600"}`}
    >
      {type}
    </span>
  );
}

function getDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const columns: ColumnDef<ThingRow>[] = [
  {
    accessorKey: "thingType",
    header: ({ column }) => (
      <SortableHeader column={column} title="Type">
        Type
      </SortableHeader>
    ),
    cell: ({ row }) => thingTypeBadge(row.original.thingType),
    filterFn: "equalsString",
  },
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column} title="Title">
        Title
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const thing = row.original;
      const displayTitle =
        thing.title.length > 80
          ? thing.title.slice(0, 77) + "..."
          : thing.title;

      if (thing.href) {
        return (
          <a
            href={thing.href}
            className="inline-flex items-center gap-1 text-sm font-medium text-accent-foreground hover:underline no-underline max-w-[400px]"
            title={thing.title}
            {...(thing.isExternal
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
          >
            <span className="truncate">{displayTitle}</span>
            {thing.isExternal && (
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
          </a>
        );
      }

      return (
        <span
          className="text-sm max-w-[400px] truncate block"
          title={thing.title}
        >
          {displayTitle}
        </span>
      );
    },
  },
  {
    accessorKey: "entityType",
    header: ({ column }) => (
      <SortableHeader column={column} title="Entity type">
        Entity Type
      </SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.entityType ? (
        <span className="text-xs text-muted-foreground">
          {row.original.entityType}
        </span>
      ) : null,
  },
  {
    accessorKey: "sourceUrl",
    header: "Source",
    cell: ({ row }) => {
      const url = row.original.sourceUrl;
      if (!url) return null;
      const domain = getDomain(url);
      if (!domain) return null;
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:underline"
          title={url}
        >
          {domain}
        </a>
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;

interface ThingsTableProps {
  data: ThingRow[];
  typeFilter?: string;
}

export function ThingsTable({ data, typeFilter }: ThingsTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "title", desc: false },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [selectedType, setSelectedType] = useState(typeFilter || "");
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: PAGE_SIZE,
  });

  // Reset to first page when filters change
  useEffect(() => {
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }, [globalFilter, selectedType]);

  // Compute type counts
  const typeCounts: Record<string, number> = {};
  for (const row of data) {
    typeCounts[row.thingType] = (typeCounts[row.thingType] || 0) + 1;
  }

  const filteredData = selectedType
    ? data.filter((r) => r.thingType === selectedType)
    : data;

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, globalFilter, pagination },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const totalFiltered = table.getFilteredRowModel().rows.length;
  const pageCount = table.getPageCount();
  const currentPage = pagination.pageIndex + 1;
  const rangeStart = pagination.pageIndex * PAGE_SIZE + 1;
  const rangeEnd = Math.min(currentPage * PAGE_SIZE, totalFiltered);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search things..."
            aria-label="Search things"
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border rounded-md bg-background"
          />
        </div>

        <select
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
          aria-label="Filter things by type"
          className="px-3 py-2 text-sm border rounded-md bg-background"
        >
          <option value="">All types ({data.length})</option>
          {Object.entries(typeCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => (
              <option key={type} value={type}>
                {type} ({count})
              </option>
            ))}
        </select>
      </div>

      {/* Count */}
      <p className="text-sm text-muted-foreground">
        Showing {totalFiltered === 0 ? 0 : rangeStart}–
        {rangeEnd} of {totalFiltered} things
        {totalFiltered !== data.length && ` (${data.length} total)`}
      </p>

      {/* Table */}
      <DataTable table={table} />

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between px-1">
          <span className="text-sm text-muted-foreground">
            Page {currentPage} of {pageCount}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </button>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Next page"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
