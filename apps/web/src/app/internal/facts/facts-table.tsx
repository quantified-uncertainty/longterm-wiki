"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
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
} from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";

// ---------------------------------------------------------------------------
// Row types passed from server component
// ---------------------------------------------------------------------------

export interface FactRow {
  entityId: string;
  entityName: string;
  entityType: string;
  entityHref: string;
  propertyId: string;
  propertyName: string;
  propertyCategory: string;
  displayValue: string;
  asOf: string | null;
  hasSource: boolean;
  staleDays: number | null;
}

export interface PropertyRow {
  id: string;
  name: string;
  category: string;
  dataType: string;
  factCount: number;
  entityCount: number;
  applicableCount: number;
  coveragePct: number;
}

export interface EntityCoverageRow {
  entityId: string;
  entityName: string;
  entityType: string;
  entityHref: string;
  factCount: number;
  itemCount: number;
  sourceCoveragePct: number;
  propertyCount: number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const CATEGORY_COLORS: Record<string, string> = {
  financial: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
  people: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
  biographical: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300",
  product: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
  organization: "bg-teal-100 text-teal-700 dark:bg-teal-900/50 dark:text-teal-300",
  safety: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  model: "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300",
  risk: "bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300",
  epistemic: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300",
  concept: "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300",
  approach: "bg-lime-100 text-lime-700 dark:bg-lime-900/50 dark:text-lime-300",
  debate: "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300",
  research: "bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300",
  general: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  event: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
  policy: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/50 dark:text-fuchsia-300",
  project: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300",
  relationship: "bg-pink-100 text-pink-700 dark:bg-pink-900/50 dark:text-pink-300",
  funder: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200",
  historical: "bg-stone-100 text-stone-700 dark:bg-stone-900/50 dark:text-stone-300",
  incident: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
};
const DEFAULT_CAT_COLOR = "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";

function CategoryBadge({ category }: { category: string }) {
  const color = CATEGORY_COLORS[category] ?? DEFAULT_CAT_COLOR;
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${color}`}>
      {category}
    </span>
  );
}

function Dash() {
  return <span className="text-muted-foreground/30 text-xs">-</span>;
}

function CoverageBadge({ pct }: { pct: number }) {
  const color =
    pct >= 80
      ? "text-emerald-600"
      : pct >= 50
        ? "text-amber-600"
        : "text-red-500";
  return (
    <span className={`text-xs tabular-nums font-medium ${color}`}>
      {Math.round(pct)}%
    </span>
  );
}

function CoverageBar({ pct }: { pct: number }) {
  const bg =
    pct >= 80
      ? "bg-emerald-500"
      : pct >= 50
        ? "bg-amber-500"
        : "bg-red-400";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 rounded-full bg-muted/50 overflow-hidden">
        <div
          className={`h-full rounded-full ${bg}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{Math.round(pct)}%</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab types
// ---------------------------------------------------------------------------

type TabId = "facts" | "properties" | "entities";

const TABS: { id: TabId; label: string }[] = [
  { id: "facts", label: "Facts" },
  { id: "properties", label: "Properties" },
  { id: "entities", label: "Entity Coverage" },
];

// ---------------------------------------------------------------------------
// Facts table columns
// ---------------------------------------------------------------------------

const factsColumns: ColumnDef<FactRow>[] = [
  {
    accessorKey: "entityName",
    header: ({ column }) => <SortableHeader column={column} title="KB entity with structured data">Entity</SortableHeader>,
    cell: ({ row }) => (
      <Link href={row.original.entityHref} className="text-primary hover:underline text-sm font-medium">
        {row.original.entityName}
      </Link>
    ),
    size: 180,
  },
  {
    accessorKey: "propertyName",
    header: ({ column }) => <SortableHeader column={column} title="Property definition">Property</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-sm">{row.original.propertyName}</span>
    ),
    size: 140,
  },
  {
    accessorKey: "propertyCategory",
    header: ({ column }) => <SortableHeader column={column} title="Property category">Category</SortableHeader>,
    cell: ({ row }) => <CategoryBadge category={row.original.propertyCategory} />,
    size: 100,
  },
  {
    accessorKey: "displayValue",
    header: "Value",
    cell: ({ row }) => (
      <span className="text-sm text-foreground/90 max-w-[200px] truncate block" title={row.original.displayValue}>
        {row.original.displayValue}
      </span>
    ),
    size: 180,
  },
  {
    accessorKey: "asOf",
    header: ({ column }) => <SortableHeader column={column} title="When the fact was measured">As Of</SortableHeader>,
    cell: ({ row }) => row.original.asOf ? <span className="text-xs tabular-nums text-muted-foreground">{row.original.asOf}</span> : <Dash />,
    size: 90,
  },
  {
    accessorKey: "hasSource",
    header: ({ column }) => <SortableHeader column={column} title="Whether the fact has a source URL">Source</SortableHeader>,
    cell: ({ row }) =>
      row.original.hasSource ? (
        <span className="text-emerald-500 text-xs font-bold">&#x2713;</span>
      ) : (
        <span className="text-muted-foreground/30 text-xs">&#x2717;</span>
      ),
    size: 60,
  },
  {
    accessorKey: "staleDays",
    header: ({ column }) => <SortableHeader column={column} title="Days since the asOf date">Staleness</SortableHeader>,
    cell: ({ row }) => {
      const days = row.original.staleDays;
      if (days == null) return <Dash />;
      const color =
        days <= 90 ? "text-emerald-500" : days <= 365 ? "text-amber-500" : "text-red-400";
      const label = days <= 30 ? `${days}d` : days <= 365 ? `${Math.round(days / 30)}mo` : `${(days / 365).toFixed(1)}y`;
      return <span className={`text-xs tabular-nums font-medium ${color}`}>{label}</span>;
    },
    size: 80,
  },
];

// ---------------------------------------------------------------------------
// Properties table columns
// ---------------------------------------------------------------------------

const propertiesColumns: ColumnDef<PropertyRow>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => <SortableHeader column={column}>Name</SortableHeader>,
    cell: ({ row }) => <span className="text-sm font-medium">{row.original.name}</span>,
    size: 180,
  },
  {
    accessorKey: "category",
    header: ({ column }) => <SortableHeader column={column}>Category</SortableHeader>,
    cell: ({ row }) => <CategoryBadge category={row.original.category} />,
    size: 110,
  },
  {
    accessorKey: "dataType",
    header: ({ column }) => <SortableHeader column={column}>Type</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-xs font-mono text-muted-foreground">{row.original.dataType}</span>
    ),
    size: 80,
  },
  {
    accessorKey: "factCount",
    header: ({ column }) => <SortableHeader column={column} title="Total facts using this property">Facts</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-sm tabular-nums font-medium">{row.original.factCount}</span>
    ),
    size: 70,
  },
  {
    accessorKey: "entityCount",
    header: ({ column }) => <SortableHeader column={column} title="Number of entities that have this property">Entities</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-sm tabular-nums">{row.original.entityCount}</span>
    ),
    size: 80,
  },
  {
    accessorKey: "coveragePct",
    header: ({ column }) => <SortableHeader column={column} title="% of applicable entities that have this property">Coverage</SortableHeader>,
    cell: ({ row }) => <CoverageBar pct={row.original.coveragePct} />,
    size: 140,
  },
];

// ---------------------------------------------------------------------------
// Entity coverage table columns
// ---------------------------------------------------------------------------

const entityCoverageColumns: ColumnDef<EntityCoverageRow>[] = [
  {
    accessorKey: "entityName",
    header: ({ column }) => <SortableHeader column={column}>Entity</SortableHeader>,
    cell: ({ row }) => (
      <Link href={row.original.entityHref} className="text-primary hover:underline text-sm font-medium">
        {row.original.entityName}
      </Link>
    ),
    size: 200,
  },
  {
    accessorKey: "entityType",
    header: ({ column }) => <SortableHeader column={column}>Type</SortableHeader>,
    cell: ({ row }) => <CategoryBadge category={row.original.entityType} />,
    size: 120,
  },
  {
    accessorKey: "factCount",
    header: ({ column }) => <SortableHeader column={column} title="Total structured facts">Facts</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-sm tabular-nums font-medium">{row.original.factCount}</span>
    ),
    size: 70,
  },
  {
    accessorKey: "propertyCount",
    header: ({ column }) => <SortableHeader column={column} title="Unique properties with data">Properties</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-sm tabular-nums">{row.original.propertyCount}</span>
    ),
    size: 90,
  },
  {
    accessorKey: "itemCount",
    header: ({ column }) => <SortableHeader column={column} title="Collection entries (funding rounds, key people, etc.)">Items</SortableHeader>,
    cell: ({ row }) =>
      row.original.itemCount > 0 ? (
        <span className="text-sm tabular-nums">{row.original.itemCount}</span>
      ) : (
        <Dash />
      ),
    size: 70,
  },
  {
    accessorKey: "sourceCoveragePct",
    header: ({ column }) => <SortableHeader column={column} title="% of facts with a source URL">Source Coverage</SortableHeader>,
    cell: ({ row }) => <CoverageBadge pct={row.original.sourceCoveragePct} />,
    size: 110,
  },
];

// ---------------------------------------------------------------------------
// Main table component
// ---------------------------------------------------------------------------

export function FactsDashboardTable({
  facts,
  properties,
  entityCoverage,
}: {
  facts: FactRow[];
  properties: PropertyRow[];
  entityCoverage: EntityCoverageRow[];
}) {
  const [activeTab, setActiveTab] = useState<TabId>("facts");
  const [globalFilter, setGlobalFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  // Unique categories for filter dropdown
  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const p of properties) cats.add(p.category);
    return Array.from(cats).sort();
  }, [properties]);

  // Unique entity types for filter dropdown
  const entityTypes = useMemo(() => {
    const types = new Set<string>();
    for (const e of entityCoverage) types.add(e.entityType);
    return Array.from(types).sort();
  }, [entityCoverage]);

  // Filter facts based on active filters
  const filteredFacts = useMemo(() => {
    let result = facts;
    if (categoryFilter !== "all") {
      result = result.filter((f) => f.propertyCategory === categoryFilter);
    }
    if (sourceFilter === "yes") {
      result = result.filter((f) => f.hasSource);
    } else if (sourceFilter === "no") {
      result = result.filter((f) => !f.hasSource);
    }
    if (globalFilter) {
      const lc = globalFilter.toLowerCase();
      result = result.filter(
        (f) =>
          f.entityName.toLowerCase().includes(lc) ||
          f.propertyName.toLowerCase().includes(lc) ||
          f.displayValue.toLowerCase().includes(lc)
      );
    }
    return result;
  }, [facts, categoryFilter, sourceFilter, globalFilter]);

  // Filter properties
  const filteredProperties = useMemo(() => {
    let result = properties;
    if (categoryFilter !== "all") {
      result = result.filter((p) => p.category === categoryFilter);
    }
    if (globalFilter) {
      const lc = globalFilter.toLowerCase();
      result = result.filter(
        (p) => p.name.toLowerCase().includes(lc) || p.id.toLowerCase().includes(lc)
      );
    }
    return result;
  }, [properties, categoryFilter, globalFilter]);

  // Filter entity coverage
  const filteredEntities = useMemo(() => {
    let result = entityCoverage;
    if (categoryFilter !== "all") {
      result = result.filter((e) => e.entityType === categoryFilter);
    }
    if (globalFilter) {
      const lc = globalFilter.toLowerCase();
      result = result.filter((e) => e.entityName.toLowerCase().includes(lc));
    }
    return result;
  }, [entityCoverage, categoryFilter, globalFilter]);

  // ── Facts table instance ────────────────────────────────────────
  const [factsSorting, setFactsSorting] = useState<SortingState>([
    { id: "entityName", desc: false },
  ]);
  const factsTable = useReactTable({
    data: filteredFacts,
    columns: factsColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setFactsSorting,
    state: { sorting: factsSorting, pagination: { pageIndex: 0, pageSize: 100 } },
  });

  // ── Properties table instance ───────────────────────────────────
  const [propsSorting, setPropsSorting] = useState<SortingState>([
    { id: "factCount", desc: true },
  ]);
  const propsTable = useReactTable({
    data: filteredProperties,
    columns: propertiesColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setPropsSorting,
    state: { sorting: propsSorting, pagination: { pageIndex: 0, pageSize: 100 } },
  });

  // ── Entity coverage table instance ──────────────────────────────
  const [entitySorting, setEntitySorting] = useState<SortingState>([
    { id: "factCount", desc: true },
  ]);
  const entityTable = useReactTable({
    data: filteredEntities,
    columns: entityCoverageColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setEntitySorting,
    state: { sorting: entitySorting, pagination: { pageIndex: 0, pageSize: 100 } },
  });

  // Determine which filter options to show in the category dropdown
  // For the entities tab, show entity types; for others, show property categories
  const filterOptions = activeTab === "entities" ? entityTypes : categories;
  const filterLabel = activeTab === "entities" ? "Type" : "Category";

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border/60">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setActiveTab(tab.id);
              setCategoryFilter("all");
              setSourceFilter("all");
            }}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            }`}
          >
            {tab.label}
            <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
              {tab.id === "facts" && `(${filteredFacts.length})`}
              {tab.id === "properties" && `(${filteredProperties.length})`}
              {tab.id === "entities" && `(${filteredEntities.length})`}
            </span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All {filterLabel}s</option>
          {filterOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        {activeTab === "facts" && (
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All Sources</option>
            <option value="yes">Has Source</option>
            <option value="no">No Source</option>
          </select>
        )}

        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {activeTab === "facts" && `${filteredFacts.length} facts`}
          {activeTab === "properties" && `${filteredProperties.length} properties`}
          {activeTab === "entities" && `${filteredEntities.length} entities`}
        </span>
      </div>

      {/* Table content */}
      {activeTab === "facts" && (
        <DataTable table={factsTable} stickyFirstColumn />
      )}
      {activeTab === "properties" && (
        <DataTable table={propsTable} />
      )}
      {activeTab === "entities" && (
        <DataTable table={entityTable} stickyFirstColumn />
      )}
    </div>
  );
}
