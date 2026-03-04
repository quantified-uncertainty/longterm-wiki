"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import type { PropertyRow } from "@/app/statements/components/statements-data";

// ── Helpers ───────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  financial:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  organizational:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  safety:
    "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  performance:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  milestone:
    "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
  relation:
    "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300",
};

function CategoryBadge({ category }: { category: string }) {
  const className =
    CATEGORY_COLORS[category] ??
    "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300";

  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${className}`}
    >
      {category}
    </span>
  );
}

// ── Table Component ───────────────────────────────────────────────────────

export function PropertiesTable({ data }: { data: PropertyRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "statementCount", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");

  const columns: ColumnDef<PropertyRow>[] = useMemo(
    () => [
      {
        accessorKey: "label",
        header: ({ column }) => (
          <SortableHeader column={column}>Label</SortableHeader>
        ),
        cell: ({ row }) => (
          <Link
            href={`/statements/browse?propertyId=${row.original.id}`}
            className="text-xs font-medium text-blue-600 hover:underline"
            title={row.original.id}
          >
            {row.original.label}
          </Link>
        ),
        size: 160,
      },
      {
        accessorKey: "category",
        header: ({ column }) => (
          <SortableHeader column={column}>Category</SortableHeader>
        ),
        cell: ({ row }) => (
          <CategoryBadge category={row.original.category} />
        ),
        size: 120,
      },
      {
        accessorKey: "valueType",
        header: ({ column }) => (
          <SortableHeader column={column}>Value Type</SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-gray-100 text-gray-700 dark:bg-gray-800/50 dark:text-gray-300">
            {row.original.valueType}
          </span>
        ),
        size: 100,
      },
      {
        accessorKey: "unitFormatId",
        header: ({ column }) => (
          <SortableHeader column={column}>Unit Format</SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground font-mono">
            {row.original.unitFormatId ?? "\u2014"}
          </span>
        ),
        size: 110,
      },
      {
        accessorKey: "stalenessCadence",
        header: ({ column }) => (
          <SortableHeader column={column}>Cadence</SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {row.original.stalenessCadence ?? "\u2014"}
          </span>
        ),
        size: 100,
      },
      {
        accessorKey: "statementCount",
        header: ({ column }) => (
          <SortableHeader column={column}>Statements</SortableHeader>
        ),
        cell: ({ row }) => (
          <span className="text-xs font-semibold tabular-nums">
            {row.original.statementCount.toLocaleString("en-US")}
          </span>
        ),
        size: 100,
      },
      {
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => {
          const desc = row.original.description;
          if (!desc)
            return (
              <span className="text-muted-foreground text-xs">{"\u2014"}</span>
            );
          return (
            <span
              className="text-xs line-clamp-2 text-muted-foreground"
              title={desc}
            >
              {desc}
            </span>
          );
        },
        size: 250,
      },
    ],
    []
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search properties..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {table.getFilteredRowModel().rows.length} of {data.length}
        </span>
      </div>

      <DataTable table={table} />
    </div>
  );
}
