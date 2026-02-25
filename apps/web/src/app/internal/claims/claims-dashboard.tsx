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
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
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
import type { ClaimRow } from "@wiki-server/api-types";

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface EntityRow {
  entityId: string;
  total: number;
  verified: number;
  unverified: number;
  unsourced: number;
  multiEntity: number;
  categories: Record<string, number>;
}

export interface RelationshipRow {
  from: string;
  to: string;
  count: number;
  sampleClaims: string[];
}

export interface ClaimsDashboardData {
  stats: {
    total: number;
    byClaimType: Record<string, number>;
    byClaimCategory: Record<string, number>;
    multiEntityClaims: number;
    factLinkedClaims: number;
  };
  entityRows: EntityRow[];
  relationshipRows: RelationshipRow[];
  claims: ClaimRow[];
}

// ---------------------------------------------------------------------------
// Badge components
// ---------------------------------------------------------------------------

const CATEGORY_COLORS: Record<string, string> = {
  factual: "bg-blue-50 text-blue-700 border-blue-200",
  opinion: "bg-purple-50 text-purple-700 border-purple-200",
  analytical: "bg-amber-50 text-amber-700 border-amber-200",
  speculative: "bg-orange-50 text-orange-700 border-orange-200",
  relational: "bg-teal-50 text-teal-700 border-teal-200",
  uncategorized: "bg-gray-50 text-gray-500 border-gray-200",
};

function CategoryBadge({ category }: { category: string }) {
  const cls = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.uncategorized;
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {category}
    </span>
  );
}

const CONFIDENCE_COLORS: Record<string, string> = {
  verified: "bg-green-100 text-green-800",
  unverified: "bg-yellow-100 text-yellow-800",
  unsourced: "bg-red-100 text-red-800",
};

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const cls = CONFIDENCE_COLORS[confidence] ?? "bg-gray-100 text-gray-800";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>
      {confidence}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Distribution bar
// ---------------------------------------------------------------------------

const BAR_COLORS: Record<string, string> = {
  factual: "bg-blue-400",
  opinion: "bg-purple-400",
  analytical: "bg-amber-400",
  speculative: "bg-orange-400",
  relational: "bg-teal-400",
  uncategorized: "bg-gray-300",
  // Claim types
  numeric: "bg-sky-400",
  historical: "bg-indigo-400",
  evaluative: "bg-purple-400",
  causal: "bg-amber-400",
  consensus: "bg-pink-400",
};

function DistributionBar({
  data,
  total,
}: {
  data: Record<string, number>;
  total: number;
}) {
  if (total === 0) return null;
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-1.5">
      <div className="flex h-3 rounded overflow-hidden">
        {entries.map(([key, cnt]) => (
          <div
            key={key}
            className={`${BAR_COLORS[key] ?? "bg-gray-300"} transition-all`}
            style={{ width: `${(cnt / total) * 100}%` }}
            title={`${key}: ${cnt} (${Math.round((cnt / total) * 100)}%)`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {entries.map(([key, cnt]) => (
          <span key={key} className="text-[11px] text-muted-foreground flex items-center gap-1">
            <span className={`inline-block w-2 h-2 rounded-sm ${BAR_COLORS[key] ?? "bg-gray-300"}`} />
            {key} ({cnt})
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab button
// ---------------------------------------------------------------------------

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-sm rounded-t border-b-2 transition-colors cursor-pointer ${
        active
          ? "border-blue-600 text-blue-700 font-medium bg-blue-50/50"
          : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50"
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Entity coverage table columns
// ---------------------------------------------------------------------------

const entityColumns: ColumnDef<EntityRow>[] = [
  {
    accessorKey: "entityId",
    header: ({ column }) => <SortableHeader column={column}>Entity</SortableHeader>,
    cell: ({ row }) => (
      <Link
        href={`/wiki/${row.original.entityId}`}
        className="font-mono text-blue-600 hover:underline text-sm"
      >
        {row.original.entityId}
      </Link>
    ),
  },
  {
    accessorKey: "total",
    header: ({ column }) => <SortableHeader column={column}>Claims</SortableHeader>,
    cell: ({ row }) => (
      <span className="font-mono tabular-nums">{row.original.total}</span>
    ),
  },
  {
    accessorKey: "verified",
    header: ({ column }) => <SortableHeader column={column}>Verified</SortableHeader>,
    cell: ({ row }) => {
      const r = row.original;
      const pct = r.total > 0 ? Math.round((r.verified / r.total) * 100) : 0;
      return (
        <span className="tabular-nums text-sm">
          <span className="text-green-700">{r.verified}</span>
          <span className="text-muted-foreground ml-1 text-xs">({pct}%)</span>
        </span>
      );
    },
  },
  {
    accessorKey: "unsourced",
    header: ({ column }) => <SortableHeader column={column}>Unsourced</SortableHeader>,
    cell: ({ row }) => (
      <span className="tabular-nums text-sm text-red-600">{row.original.unsourced}</span>
    ),
  },
  {
    accessorKey: "multiEntity",
    header: ({ column }) => <SortableHeader column={column}>Multi-Entity</SortableHeader>,
    cell: ({ row }) => (
      <span className="tabular-nums text-sm">{row.original.multiEntity}</span>
    ),
  },
  {
    id: "categories",
    header: "Categories",
    cell: ({ row }) => {
      const cats = row.original.categories;
      return (
        <div className="flex flex-wrap gap-1">
          {Object.entries(cats)
            .sort((a, b) => b[1] - a[1])
            .map(([cat, cnt]) => (
              <span key={cat} className="flex items-center gap-0.5">
                <CategoryBadge category={cat} />
                <span className="text-[10px] text-muted-foreground">{cnt}</span>
              </span>
            ))}
        </div>
      );
    },
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) => (
      <Link
        href={`/wiki/${row.original.entityId}/data`}
        className="text-xs text-blue-600 hover:underline whitespace-nowrap"
      >
        View data
      </Link>
    ),
  },
];

// ---------------------------------------------------------------------------
// Relationship table columns
// ---------------------------------------------------------------------------

const relationshipColumns: ColumnDef<RelationshipRow>[] = [
  {
    accessorKey: "from",
    header: ({ column }) => <SortableHeader column={column}>Entity A</SortableHeader>,
    cell: ({ row }) => (
      <Link
        href={`/wiki/${row.original.from}`}
        className="font-mono text-blue-600 hover:underline text-sm"
      >
        {row.original.from}
      </Link>
    ),
  },
  {
    accessorKey: "to",
    header: ({ column }) => <SortableHeader column={column}>Entity B</SortableHeader>,
    cell: ({ row }) => (
      <span className="font-mono text-sm">{row.original.to}</span>
    ),
  },
  {
    accessorKey: "count",
    header: ({ column }) => <SortableHeader column={column}>Claims</SortableHeader>,
    cell: ({ row }) => (
      <span className="font-mono tabular-nums font-medium">{row.original.count}</span>
    ),
  },
  {
    id: "sample",
    header: "Sample Claim",
    cell: ({ row }) => {
      const sample = row.original.sampleClaims[0];
      if (!sample) return <span className="text-muted-foreground">-</span>;
      return (
        <span className="text-xs text-muted-foreground" title={sample}>
          {sample.length > 100 ? sample.slice(0, 100) + "..." : sample}
        </span>
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Claims table columns
// ---------------------------------------------------------------------------

const claimColumns: ColumnDef<ClaimRow>[] = [
  {
    accessorKey: "entityId",
    header: ({ column }) => <SortableHeader column={column}>Entity</SortableHeader>,
    cell: ({ row }) => (
      <Link
        href={`/wiki/${row.original.entityId}`}
        className="font-mono text-blue-600 hover:underline text-xs"
      >
        {row.original.entityId}
      </Link>
    ),
    filterFn: "equalsString",
  },
  {
    accessorKey: "claimText",
    header: "Claim",
    cell: ({ row }) => (
      <span className="text-xs" title={row.original.claimText}>
        {row.original.claimText.length > 120
          ? row.original.claimText.slice(0, 120) + "..."
          : row.original.claimText}
      </span>
    ),
  },
  {
    accessorKey: "claimType",
    header: ({ column }) => <SortableHeader column={column}>Type</SortableHeader>,
    cell: ({ row }) => (
      <span className="font-mono text-[10px]">{row.original.claimType}</span>
    ),
    filterFn: "equalsString",
  },
  {
    accessorKey: "claimCategory",
    header: ({ column }) => <SortableHeader column={column}>Category</SortableHeader>,
    cell: ({ row }) => (
      <CategoryBadge category={row.original.claimCategory ?? "uncategorized"} />
    ),
    filterFn: (row, _columnId, filterValue) => {
      const cat = row.original.claimCategory ?? "uncategorized";
      return cat === filterValue;
    },
  },
  {
    accessorKey: "confidence",
    header: ({ column }) => <SortableHeader column={column}>Confidence</SortableHeader>,
    cell: ({ row }) => (
      <ConfidenceBadge confidence={row.original.confidence ?? "unverified"} />
    ),
    filterFn: "equalsString",
  },
  {
    id: "relatedEntities",
    header: "Related",
    cell: ({ row }) => {
      const entities = row.original.relatedEntities;
      if (!entities || entities.length === 0)
        return <span className="text-muted-foreground text-[10px]">-</span>;
      return (
        <div className="flex flex-wrap gap-0.5">
          {entities.slice(0, 3).map((eid) => (
            <span
              key={eid}
              className="inline-block px-1 py-0.5 rounded text-[10px] bg-gray-100 text-gray-600"
            >
              {eid}
            </span>
          ))}
          {entities.length > 3 && (
            <span className="text-[10px] text-muted-foreground">
              +{entities.length - 3}
            </span>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: "section",
    header: "Section",
    cell: ({ row }) => {
      const section = row.original.section ?? row.original.value ?? "-";
      return (
        <span className="text-xs text-muted-foreground truncate max-w-[100px] block" title={section}>
          {section}
        </span>
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Generic data table
// ---------------------------------------------------------------------------

function DataTableSection<T>({
  columns,
  data,
  pageSize = 20,
  globalFilter,
  columnFilters,
}: {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  pageSize?: number;
  globalFilter?: string;
  columnFilters?: { id: string; value: string }[];
}) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      globalFilter,
      columnFilters,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  return (
    <div>
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length > 0 ? (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-muted-foreground py-8">
                No results.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {/* Pagination */}
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between px-2 py-3 text-sm">
          <span className="text-muted-foreground text-xs">
            {table.getFilteredRowModel().rows.length} rows
          </span>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => table.setPageIndex(0)} disabled={!table.getCanPreviousPage()} className="p-1 rounded hover:bg-muted disabled:opacity-30 cursor-pointer disabled:cursor-default">
              <ChevronsLeft className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} className="p-1 rounded hover:bg-muted disabled:opacity-30 cursor-pointer disabled:cursor-default">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-muted-foreground px-2 tabular-nums">
              {table.getState().pagination.pageIndex + 1} / {table.getPageCount()}
            </span>
            <button type="button" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} className="p-1 rounded hover:bg-muted disabled:opacity-30 cursor-pointer disabled:cursor-default">
              <ChevronRight className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => table.setPageIndex(table.getPageCount() - 1)} disabled={!table.getCanNextPage()} className="p-1 rounded hover:bg-muted disabled:opacity-30 cursor-pointer disabled:cursor-default">
              <ChevronsRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------

type Tab = "overview" | "entities" | "relationships" | "claims";

export function ClaimsDashboard({ data }: { data: ClaimsDashboardData }) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [entityFilter, setEntityFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [confidenceFilter, setConfidenceFilter] = useState("");

  const claimColumnFilters = useMemo(() => {
    const filters: { id: string; value: string }[] = [];
    if (entityFilter) filters.push({ id: "entityId", value: entityFilter });
    if (categoryFilter) filters.push({ id: "claimCategory", value: categoryFilter });
    if (confidenceFilter) filters.push({ id: "confidence", value: confidenceFilter });
    return filters;
  }, [entityFilter, categoryFilter, confidenceFilter]);

  const uniqueEntities = useMemo(
    () => [...new Set(data.claims.map((c) => c.entityId))].sort(),
    [data.claims]
  );
  const uniqueCategories = useMemo(
    () => [...new Set(data.claims.map((c) => c.claimCategory ?? "uncategorized"))].sort(),
    [data.claims]
  );

  return (
    <div className="not-prose">
      {/* Tabs */}
      <div className="flex gap-1 border-b mb-4">
        <TabButton active={activeTab === "overview"} onClick={() => setActiveTab("overview")}>
          Overview
        </TabButton>
        <TabButton active={activeTab === "entities"} onClick={() => setActiveTab("entities")}>
          Entity Coverage ({data.entityRows.length})
        </TabButton>
        <TabButton active={activeTab === "relationships"} onClick={() => setActiveTab("relationships")}>
          Relationships ({data.relationshipRows.length})
        </TabButton>
        <TabButton active={activeTab === "claims"} onClick={() => setActiveTab("claims")}>
          All Claims ({data.stats.total})
        </TabButton>
      </div>

      {/* Tab content */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          {/* Category distribution */}
          <div className="rounded-lg border p-4">
            <h3 className="text-sm font-semibold mb-3">Claim Categories</h3>
            <DistributionBar data={data.stats.byClaimCategory} total={data.stats.total} />
          </div>

          {/* Type distribution */}
          <div className="rounded-lg border p-4">
            <h3 className="text-sm font-semibold mb-3">Claim Types</h3>
            <DistributionBar data={data.stats.byClaimType} total={data.stats.total} />
          </div>

          {/* Top entities */}
          <div className="rounded-lg border p-4">
            <h3 className="text-sm font-semibold mb-3">Top Entities by Claims</h3>
            <div className="space-y-2">
              {data.entityRows.slice(0, 10).map((row) => {
                const verifiedPct = row.total > 0 ? (row.verified / row.total) * 100 : 0;
                return (
                  <div key={row.entityId} className="flex items-center gap-3">
                    <Link
                      href={`/wiki/${row.entityId}`}
                      className="font-mono text-sm text-blue-600 hover:underline w-40 truncate"
                    >
                      {row.entityId}
                    </Link>
                    <div className="flex-1 flex items-center gap-2">
                      <div className="flex-1 h-4 bg-gray-100 rounded overflow-hidden">
                        <div
                          className="h-full bg-green-400 rounded-l"
                          style={{ width: `${(row.total / data.entityRows[0].total) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs tabular-nums w-8 text-right">{row.total}</span>
                      <span className="text-[10px] text-muted-foreground w-12 text-right tabular-nums">
                        {Math.round(verifiedPct)}% verified
                      </span>
                    </div>
                    {row.multiEntity > 0 && (
                      <span className="text-[10px] text-teal-600 whitespace-nowrap">
                        {row.multiEntity} linked
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Top relationships */}
          {data.relationshipRows.length > 0 && (
            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-semibold mb-3">Top Entity Relationships</h3>
              <div className="space-y-1.5">
                {data.relationshipRows.slice(0, 15).map((rel, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <Link
                      href={`/wiki/${rel.from}`}
                      className="font-mono text-blue-600 hover:underline text-xs"
                    >
                      {rel.from}
                    </Link>
                    <span className="text-muted-foreground text-xs">&harr;</span>
                    <span className="font-mono text-xs">{rel.to}</span>
                    <span className="tabular-nums font-medium text-xs ml-auto">{rel.count}</span>
                    <span className="text-[10px] text-muted-foreground truncate max-w-[300px]">
                      {rel.sampleClaims[0]?.slice(0, 80)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === "entities" && (
        <DataTableSection columns={entityColumns} data={data.entityRows} pageSize={25} />
      )}

      {activeTab === "relationships" && (
        <DataTableSection columns={relationshipColumns} data={data.relationshipRows} pageSize={25} />
      )}

      {activeTab === "claims" && (
        <div>
          {/* Filters */}
          <div className="flex flex-wrap gap-2 mb-3">
            <select
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value)}
              className="text-xs border rounded px-2 py-1"
            >
              <option value="">All entities</option>
              {uniqueEntities.map((eid) => (
                <option key={eid} value={eid}>{eid}</option>
              ))}
            </select>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="text-xs border rounded px-2 py-1"
            >
              <option value="">All categories</option>
              {uniqueCategories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
            <select
              value={confidenceFilter}
              onChange={(e) => setConfidenceFilter(e.target.value)}
              className="text-xs border rounded px-2 py-1"
            >
              <option value="">All confidence</option>
              <option value="verified">verified</option>
              <option value="unverified">unverified</option>
              <option value="unsourced">unsourced</option>
            </select>
            {(entityFilter || categoryFilter || confidenceFilter) && (
              <button
                type="button"
                onClick={() => { setEntityFilter(""); setCategoryFilter(""); setConfidenceFilter(""); }}
                className="text-xs text-blue-600 hover:underline cursor-pointer"
              >
                Clear filters
              </button>
            )}
          </div>
          <DataTableSection
            columns={claimColumns}
            data={data.claims}
            pageSize={30}
            columnFilters={claimColumnFilters}
          />
        </div>
      )}
    </div>
  );
}
