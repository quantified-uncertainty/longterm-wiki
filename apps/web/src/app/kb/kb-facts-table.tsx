"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import Link from "next/link";
import type {
  ColumnDef,
  SortingState,
  VisibilityState,
} from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search, Columns3 } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import type { FactRow } from "./kb-facts-content";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\u2026" : s;
}

const COMPLETENESS_COLORS = [
  "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  "bg-lime-100 text-lime-700 dark:bg-lime-900/40 dark:text-lime-300",
  "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
];

const allColumns: ColumnDef<FactRow>[] = [
  {
    accessorKey: "entityName",
    header: ({ column }) => (
      <SortableHeader column={column}>Entity</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/kb/entity/${row.original.entityId}`}
        className="text-primary hover:underline text-xs font-medium"
      >
        {row.original.entityName}
      </Link>
    ),
    size: 160,
  },
  {
    accessorKey: "propertyName",
    header: ({ column }) => (
      <SortableHeader column={column}>Property</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/kb/property/${row.original.propertyId}`}
        className="text-primary hover:underline text-xs"
      >
        {row.original.propertyName}
      </Link>
    ),
    size: 140,
  },
  {
    accessorKey: "category",
    header: ({ column }) => (
      <SortableHeader column={column}>Category</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs capitalize text-muted-foreground">
        {row.original.category}
      </span>
    ),
    size: 100,
  },
  {
    accessorKey: "displayValue",
    header: ({ column }) => (
      <SortableHeader column={column}>Value</SortableHeader>
    ),
    cell: ({ row }) => (
      <span
        className="text-xs font-medium tabular-nums"
        title={row.original.displayValue}
      >
        {truncate(row.original.displayValue, 60)}
      </span>
    ),
    size: 200,
  },
  {
    accessorKey: "valueType",
    header: ({ column }) => (
      <SortableHeader column={column}>Value Type</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground font-mono">
        {row.original.valueType}
      </span>
    ),
    size: 80,
  },
  {
    accessorKey: "asOf",
    header: ({ column }) => (
      <SortableHeader column={column}>As Of</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground tabular-nums">
        {row.original.asOf}
      </span>
    ),
    size: 90,
  },
  {
    accessorKey: "validEnd",
    header: ({ column }) => (
      <SortableHeader column={column}>Valid End</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground tabular-nums">
        {row.original.validEnd}
      </span>
    ),
    size: 90,
  },
  {
    accessorKey: "isCurrent",
    header: ({ column }) => (
      <SortableHeader column={column}>Current</SortableHeader>
    ),
    cell: ({ row }) => (
      <span
        className={`text-xs font-medium ${row.original.isCurrent ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
      >
        {row.original.isCurrent ? "Yes" : "No"}
      </span>
    ),
    size: 70,
  },
  {
    accessorKey: "freshnessMonths",
    header: ({ column }) => (
      <SortableHeader column={column}>Freshness</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground tabular-nums">
        {row.original.freshnessLabel}
      </span>
    ),
    sortingFn: "basic",
    size: 90,
  },
  {
    accessorKey: "hasSource",
    header: ({ column }) => (
      <SortableHeader column={column}>Source</SortableHeader>
    ),
    cell: ({ row }) => {
      if (row.original.source) {
        return (
          <a
            href={row.original.source}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline"
            title={row.original.source}
          >
            Link
          </a>
        );
      }
      return <span className="text-xs text-muted-foreground/30">&mdash;</span>;
    },
    size: 70,
  },
  {
    accessorKey: "sourceQuote",
    header: ({ column }) => (
      <SortableHeader column={column}>Source Quote</SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.sourceQuote ? (
        <span
          className="text-xs text-muted-foreground italic"
          title={row.original.sourceQuote}
        >
          {truncate(row.original.sourceQuote, 60)}
        </span>
      ) : (
        <span className="text-muted-foreground/40 text-xs">-</span>
      ),
    size: 200,
  },
  {
    accessorKey: "notes",
    header: ({ column }) => (
      <SortableHeader column={column}>Notes</SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.notes ? (
        <span
          className="text-xs text-muted-foreground"
          title={row.original.notes}
        >
          {truncate(row.original.notes, 60)}
        </span>
      ) : (
        <span className="text-muted-foreground/40 text-xs">-</span>
      ),
    size: 200,
  },
  {
    accessorKey: "entityType",
    header: ({ column }) => (
      <SortableHeader column={column}>Entity Type</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs capitalize text-muted-foreground">
        {row.original.entityType}
      </span>
    ),
    size: 110,
  },
  {
    accessorKey: "unit",
    header: ({ column }) => (
      <SortableHeader column={column}>Unit</SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.unit ? (
        <span className="text-xs text-muted-foreground font-mono">
          {row.original.unit}
        </span>
      ) : (
        <span className="text-muted-foreground/40 text-xs">-</span>
      ),
    size: 80,
  },
  {
    accessorKey: "temporal",
    header: ({ column }) => (
      <SortableHeader column={column}>Temporal</SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.temporal ? (
        <span className="text-xs text-blue-600 dark:text-blue-400">Yes</span>
      ) : (
        <span className="text-muted-foreground/40 text-xs">-</span>
      ),
    size: 70,
  },
  {
    accessorKey: "currency",
    header: ({ column }) => (
      <SortableHeader column={column}>Currency</SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.currency ? (
        <span className="text-xs text-muted-foreground font-mono">
          {row.original.currency}
        </span>
      ) : (
        <span className="text-muted-foreground/40 text-xs">-</span>
      ),
    size: 70,
  },
  {
    accessorKey: "usdEquivalent",
    header: ({ column }) => (
      <SortableHeader column={column}>USD Equiv</SortableHeader>
    ),
    cell: ({ row }) => {
      const v = row.original.usdEquivalent;
      return v != null ? (
        <span className="text-xs text-muted-foreground tabular-nums">
          ${v.toLocaleString()}
        </span>
      ) : (
        <span className="text-muted-foreground/40 text-xs">-</span>
      );
    },
    sortUndefined: "last",
    size: 100,
  },
  {
    accessorKey: "derivedFrom",
    header: ({ column }) => (
      <SortableHeader column={column}>Derived From</SortableHeader>
    ),
    cell: ({ row }) =>
      row.original.derivedFrom ? (
        <span className="text-xs text-muted-foreground font-mono">
          {truncate(row.original.derivedFrom, 30)}
        </span>
      ) : (
        <span className="text-muted-foreground/40 text-xs">-</span>
      ),
    size: 120,
  },
  {
    accessorKey: "completenessScore",
    header: ({ column }) => (
      <SortableHeader column={column}>Completeness</SortableHeader>
    ),
    cell: ({ row }) => {
      const score = row.original.completenessScore;
      return (
        <span
          className={`inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${COMPLETENESS_COLORS[score] ?? COMPLETENESS_COLORS[0]}`}
        >
          {score}/4
        </span>
      );
    },
    size: 90,
  },
  {
    accessorKey: "factId",
    header: ({ column }) => (
      <SortableHeader column={column}>ID</SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/kb/fact/${row.original.factId}`}
        className="text-primary hover:underline text-xs font-mono"
      >
        {row.original.factId.length > 12
          ? row.original.factId.slice(0, 12) + "\u2026"
          : row.original.factId}
      </Link>
    ),
    size: 110,
  },
];

// Columns hidden by default — everything not listed here is visible
const DEFAULT_HIDDEN: VisibilityState = {
  valueType: false,
  validEnd: false,
  isCurrent: false,
  freshnessMonths: false,
  sourceQuote: false,
  notes: false,
  entityType: false,
  unit: false,
  temporal: false,
  currency: false,
  usdEquivalent: false,
  derivedFrom: false,
  completenessScore: false,
};

export function KBFactsTable({ data }: { data: FactRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "entityName", desc: false },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [columnVisibility, setColumnVisibility] =
    useState<VisibilityState>(DEFAULT_HIDDEN);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close column picker on click outside
  useEffect(() => {
    if (!showColumnPicker) return;
    function handler(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowColumnPicker(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showColumnPicker]);

  // Close column picker on Escape
  useEffect(() => {
    if (!showColumnPicker) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") setShowColumnPicker(false);
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [showColumnPicker]);

  const entityTypes = useMemo(() => {
    const types = new Set(data.map((r) => r.entityType));
    return [...types].sort();
  }, [data]);

  const categories = useMemo(() => {
    const cats = new Set(data.map((r) => r.category));
    return [...cats].sort();
  }, [data]);

  const filteredData = useMemo(() => {
    let filtered = data;
    if (typeFilter !== "all") {
      filtered = filtered.filter((r) => r.entityType === typeFilter);
    }
    if (categoryFilter !== "all") {
      filtered = filtered.filter((r) => r.category === categoryFilter);
    }
    if (sourceFilter === "with-source") {
      filtered = filtered.filter((r) => r.hasSource);
    } else if (sourceFilter === "without-source") {
      filtered = filtered.filter((r) => !r.hasSource);
    }
    return filtered;
  }, [data, typeFilter, categoryFilter, sourceFilter]);

  const table = useReactTable({
    data: filteredData,
    columns: allColumns,
    state: { sorting, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _columnId, filterValue) => {
      const search = filterValue.toLowerCase();
      const r = row.original;
      return (
        r.entityName.toLowerCase().includes(search) ||
        r.propertyName.toLowerCase().includes(search) ||
        r.displayValue.toLowerCase().includes(search) ||
        r.category.toLowerCase().includes(search) ||
        r.notes.toLowerCase().includes(search) ||
        r.factId.toLowerCase().includes(search)
      );
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search facts..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-9 py-2 text-sm"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="all">All types</option>
          {entityTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="all">All sources</option>
          <option value="with-source">With source</option>
          <option value="without-source">Without source</option>
        </select>

        {/* Column picker — same pattern as resources-data-table */}
        <div className="relative" ref={pickerRef}>
          <button
            onClick={() => setShowColumnPicker((v) => !v)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-border rounded-md bg-background text-muted-foreground hover:bg-muted transition-colors"
          >
            <Columns3 className="h-3.5 w-3.5" />
            Columns
          </button>
          {showColumnPicker && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-2 min-w-[180px] max-h-80 overflow-y-auto">
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
      </div>
      <div className="text-xs text-muted-foreground">
        Showing {table.getFilteredRowModel().rows.length} of {data.length} facts
      </div>
      <div className="overflow-x-auto">
        <DataTable table={table} />
      </div>
    </div>
  );
}
