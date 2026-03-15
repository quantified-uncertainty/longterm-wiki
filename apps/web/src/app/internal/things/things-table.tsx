"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search, ExternalLink, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import { searchThings, fetchThingsPage, type ThingSearchRow } from "./actions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ThingRow = ThingSearchRow;

const PAGE_SIZE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verdictBadge(verdict: string | null) {
  if (!verdict) return null;
  const colors: Record<string, string> = {
    confirmed: "bg-green-100 text-green-800",
    contradicted: "bg-red-100 text-red-800",
    partial: "bg-yellow-100 text-yellow-800",
    outdated: "bg-orange-100 text-orange-800",
    unverifiable: "bg-gray-100 text-gray-600",
    unchecked: "bg-gray-50 text-gray-500",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[verdict] || "bg-gray-100 text-gray-600"}`}
    >
      {verdict}
    </span>
  );
}

function thingTypeBadge(type: string, entityType: string | null) {
  const displayType = type === "entity" && entityType ? entityType : type;

  const colors: Record<string, string> = {
    organization: "bg-blue-100 text-blue-800",
    person: "bg-blue-100 text-blue-800",
    risk: "bg-red-100 text-red-800",
    approach: "bg-blue-100 text-blue-800",
    analysis: "bg-blue-100 text-blue-800",
    concept: "bg-blue-100 text-blue-800",
    policy: "bg-blue-100 text-blue-800",
    "ai-model": "bg-blue-100 text-blue-800",
    "safety-agenda": "bg-blue-100 text-blue-800",
    capability: "bg-blue-100 text-blue-800",
    entity: "bg-blue-100 text-blue-800",
    resource: "bg-purple-100 text-purple-800",
    grant: "bg-green-100 text-green-800",
    fact: "bg-sky-100 text-sky-800",
    personnel: "bg-orange-100 text-orange-800",
    division: "bg-teal-100 text-teal-800",
    "funding-round": "bg-yellow-100 text-yellow-800",
    investment: "bg-indigo-100 text-indigo-800",
    benchmark: "bg-pink-100 text-pink-800",
    "benchmark-result": "bg-rose-100 text-rose-800",
    "equity-position": "bg-cyan-100 text-cyan-800",
    "funding-program": "bg-lime-100 text-lime-800",
    "division-personnel": "bg-amber-100 text-amber-800",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[displayType] || "bg-gray-100 text-gray-600"}`}
    >
      {displayType}
    </span>
  );
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
    cell: ({ row }) => thingTypeBadge(row.original.thingType, row.original.entityType),
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
        const isExternal = thing.href.startsWith("http");
        return (
          <a
            href={thing.href}
            className="text-sm font-medium text-accent-foreground hover:underline no-underline max-w-[400px] truncate inline-flex items-center gap-1"
            title={thing.title}
            {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {displayTitle}
            {isExternal && <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />}
          </a>
        );
      }

      return (
        <span className="text-sm max-w-[400px] truncate block" title={thing.title}>
          {displayTitle}
        </span>
      );
    },
  },
  {
    accessorKey: "parentTitle",
    header: ({ column }) => (
      <SortableHeader column={column} title="Parent">
        Parent
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const thing = row.original;
      if (!thing.parentTitle) return null;
      const displayName =
        thing.parentTitle.length > 30
          ? thing.parentTitle.slice(0, 27) + "..."
          : thing.parentTitle;
      if (thing.parentHref) {
        return (
          <a href={thing.parentHref} className="text-xs text-accent-foreground hover:underline no-underline" title={thing.parentTitle}>
            {displayName}
          </a>
        );
      }
      return <span className="text-xs text-muted-foreground" title={thing.parentTitle}>{displayName}</span>;
    },
  },
  {
    id: "page",
    header: "Page",
    cell: ({ row }) => {
      const thing = row.original;
      if (!thing.href) return null;
      const isExternal = thing.href.startsWith("http");
      if (isExternal) {
        try {
          const domain = new URL(thing.href).hostname.replace("www.", "");
          return (
            <a href={thing.href} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:underline no-underline inline-flex items-center gap-0.5">
              {domain}
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          );
        } catch { return null; }
      }
      return (
        <a href={thing.href} className="text-xs text-accent-foreground hover:underline no-underline">
          {thing.href.length > 35 ? thing.href.slice(0, 32) + "..." : thing.href}
        </a>
      );
    },
  },
  {
    accessorKey: "verdict",
    header: ({ column }) => (
      <SortableHeader column={column} title="Verdict">
        Verdict
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const thing = row.original;
      if (!thing.verdict) return null;
      return (
        <div className="flex items-center gap-1">
          {verdictBadge(thing.verdict)}
          {thing.verdictConfidence != null && (
            <span className="text-xs text-muted-foreground">
              {(thing.verdictConfidence * 100).toFixed(0)}%
            </span>
          )}
        </div>
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ThingsTableProps {
  total: number;
  typeCounts: Record<string, number>;
}

export function ThingsTable(props: ThingsTableProps) {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Loading table...</div>}>
      <ThingsTableInner {...props} />
    </Suspense>
  );
}

function ThingsTableInner({ total, typeCounts }: ThingsTableProps) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [sorting, setSorting] = useState<SortingState>([]);
  const [searchQuery, setSearchQuery] = useState(searchParams.get("q") || "");
  const [selectedType, setSelectedType] = useState(searchParams.get("type") || "");
  const [currentPage, setCurrentPage] = useState(Number(searchParams.get("page")) || 1);

  // Data state
  const [rows, setRows] = useState<ThingRow[]>([]);
  const [pageTotal, setPageTotal] = useState(total);
  const [isLoading, setIsLoading] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [mode, setMode] = useState<"browse" | "search">("browse");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Request counter to prevent stale responses from overwriting current data
  const requestId = useRef(0);

  // Update URL
  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedType) params.set("type", selectedType);
    if (searchQuery) params.set("q", searchQuery);
    if (currentPage > 1) params.set("page", String(currentPage));
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }, [selectedType, searchQuery, currentPage, router]);

  // Fetch page data
  const loadPage = useCallback(async (page: number, thingType: string) => {
    const id = ++requestId.current;
    setIsLoading(true);
    try {
      const result = await fetchThingsPage(page, PAGE_SIZE, thingType || undefined);
      if (id !== requestId.current) return; // Stale response
      if (result) {
        setRows(result.rows);
        setPageTotal(result.total);
      }
    } catch (e) {
      if (id !== requestId.current) return;
      console.warn("Failed to load things page:", e instanceof Error ? e.message : String(e));
    } finally {
      if (id === requestId.current) setIsLoading(false);
    }
  }, []);

  // Load initial page and on type/page change
  useEffect(() => {
    if (mode === "browse") {
      loadPage(currentPage, selectedType);
    }
  }, [currentPage, selectedType, mode, loadPage]);

  // Server-side search with debounce
  const doSearch = useCallback(async (query: string, thingType: string) => {
    const id = ++requestId.current;
    setMode("search");
    setIsSearching(true);
    try {
      const result = await searchThings(query, thingType || undefined);
      if (id !== requestId.current) return; // Stale response
      if (result) {
        setRows(result.results);
        setPageTotal(result.total);
      }
    } catch (e) {
      if (id !== requestId.current) return;
      console.warn("Things search failed:", e instanceof Error ? e.message : String(e));
    } finally {
      if (id === requestId.current) setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (searchQuery.length >= 2) {
      debounceTimer.current = setTimeout(() => doSearch(searchQuery, selectedType), 300);
    } else if (searchQuery.length < 2 && mode === "search") {
      // Clear search results and return to browse mode
      setMode("browse");
    }
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchQuery, selectedType, doSearch, mode]);

  // Reset page when type changes
  useEffect(() => { setCurrentPage(1); }, [selectedType]);

  const table = useReactTable({
    data: rows,
    columns,
    getRowId: (row) => row.id,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const totalPages = Math.ceil(pageTotal / PAGE_SIZE);
  const showPagination = mode === "browse" && totalPages > 1;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder={`Search all ${total.toLocaleString()} things...`}
            aria-label="Search things"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border rounded-md bg-background"
          />
          {(isSearching || isLoading) && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
          )}
        </div>

        <select
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
          aria-label="Filter things by type"
          className="px-3 py-2 text-sm border rounded-md bg-background"
        >
          <option value="">All types ({total.toLocaleString()})</option>
          {Object.entries(typeCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => (
              <option key={type} value={type}>
                {type} ({count.toLocaleString()})
              </option>
            ))}
        </select>
      </div>

      {/* Status */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {mode === "search"
            ? `${rows.length} search result${rows.length !== 1 ? "s" : ""}`
            : `Page ${currentPage} of ${totalPages} (${pageTotal.toLocaleString()} things)`}
        </p>

        {/* Pagination */}
        {showPagination && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1 || isLoading}
              className="px-2 py-1 text-sm border rounded-md hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
            >
              <ChevronLeft className="h-4 w-4" /> Prev
            </button>
            <span className="text-sm text-muted-foreground">
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages || isLoading}
              className="px-2 py-1 text-sm border rounded-md hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <DataTable table={table} />

      {/* Bottom pagination */}
      {showPagination && (
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1 || isLoading}
            className="px-2 py-1 text-sm border rounded-md hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            <ChevronLeft className="h-4 w-4" /> Prev
          </button>
          <span className="text-sm text-muted-foreground">
            {currentPage} / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages || isLoading}
            className="px-2 py-1 text-sm border rounded-md hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
