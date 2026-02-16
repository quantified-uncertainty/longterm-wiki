"use client";

import * as React from "react";
import Link from "next/link";
import type { ColumnDef, SortingState, ColumnFiltersState } from "@tanstack/react-table";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getExpandedRowModel,
} from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { InterventionCard } from "@/components/wiki/InterventionCard";
import {
  priorityBadge,
  categoryBadge,
  coverageColor,
  itnLabel,
} from "@/components/wiki/badge-styles";
import { cn } from "@lib/utils";
import { ChevronRight, Search } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InterventionRow {
  id: string;
  name: string;
  category: string;
  description: string;
  overallPriority: string;
  timelineFit: string;
  tractability: string;
  neglectedness: string;
  importance: string;
  fundingLevel: string;
  fundingShare: string;
  recommendedShift: string;
  riskCoverage: {
    accident: string;
    misuse: string;
    structural: string;
    epistemic: string;
  };
  primaryMechanism: string;
  currentState: string;
  wikiPageHref: string | null;
  relatedInterventions: string[];
  relevantResearch: Array<{ title: string; url?: string }>;
}

export interface InterventionSummary {
  total: number;
  byPriority: Record<string, number>;
  byCategory: Record<string, number>;
  riskGaps: Array<{ risk: string; coverageCount: number }>;
  recommendedIncreases: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function CoverageDot({ level }: { level: string }) {
  return (
    <span
      className={cn("text-[11px]", coverageColor[level] || coverageColor.none)}
      title={level}
    >
      {level === "none" ? "\u2014" : level}
    </span>
  );
}

const PRIORITY_ORDER: Record<string, number> = {
  "Very High": 4,
  High: 3,
  "Medium-High": 2,
  Medium: 1,
};

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const columns: ColumnDef<InterventionRow>[] = [
  {
    id: "expand",
    size: 32,
    header: () => null,
    cell: ({ row }) => (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          row.toggleExpanded();
        }}
        className="p-1 rounded hover:bg-muted transition-colors"
        aria-label={row.getIsExpanded() ? "Collapse" : "Expand"}
      >
        <ChevronRight
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            row.getIsExpanded() && "rotate-90"
          )}
        />
      </button>
    ),
  },
  {
    accessorKey: "name",
    header: ({ column }) => (
      <SortableHeader column={column}>Intervention</SortableHeader>
    ),
    cell: ({ row }) => (
      <div className="min-w-[160px]">
        {row.original.wikiPageHref ? (
          <Link
            href={row.original.wikiPageHref}
            className="text-sm font-medium text-accent-foreground hover:underline no-underline"
          >
            {row.original.name}
          </Link>
        ) : (
          <span className="text-sm font-medium">{row.original.name}</span>
        )}
        <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2 leading-relaxed max-w-[280px]">
          {row.original.description}
        </p>
      </div>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "category",
    header: ({ column }) => (
      <SortableHeader column={column}>Category</SortableHeader>
    ),
    cell: ({ row }) => {
      const cat = row.original.category;
      return (
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
            categoryBadge[cat] || categoryBadge.technical
          )}
        >
          {cat}
        </span>
      );
    },
  },
  {
    accessorKey: "overallPriority",
    header: ({ column }) => (
      <SortableHeader column={column}>Priority</SortableHeader>
    ),
    cell: ({ row }) => {
      const p = row.original.overallPriority;
      return (
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
            priorityBadge[p] || priorityBadge.Medium
          )}
        >
          {p}
        </span>
      );
    },
    sortingFn: (a, b) =>
      (PRIORITY_ORDER[a.original.overallPriority] || 0) -
      (PRIORITY_ORDER[b.original.overallPriority] || 0),
  },
  {
    accessorKey: "timelineFit",
    header: ({ column }) => (
      <SortableHeader column={column}>Timeline</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {row.original.timelineFit}
      </span>
    ),
  },
  {
    id: "itn",
    header: "ITN",
    cell: ({ row }) => (
      <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground whitespace-nowrap">
        <span>
          T: <strong>{itnLabel[row.original.tractability] || row.original.tractability}</strong>
        </span>
        <span>
          I: <strong>{itnLabel[row.original.importance] || row.original.importance}</strong>
        </span>
        <span>
          N: <strong>{itnLabel[row.original.neglectedness] || row.original.neglectedness}</strong>
        </span>
      </div>
    ),
  },
  {
    id: "riskCoverage",
    header: "Risk Coverage",
    cell: ({ row }) => {
      const rc = row.original.riskCoverage;
      return (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] min-w-[120px]">
          <span className="text-muted-foreground">Acc:</span>
          <CoverageDot level={rc.accident} />
          <span className="text-muted-foreground">Mis:</span>
          <CoverageDot level={rc.misuse} />
          <span className="text-muted-foreground">Str:</span>
          <CoverageDot level={rc.structural} />
          <span className="text-muted-foreground">Epi:</span>
          <CoverageDot level={rc.epistemic} />
        </div>
      );
    },
  },
  {
    id: "funding",
    header: "Funding",
    cell: ({ row }) => (
      <div className="text-[11px] text-muted-foreground whitespace-nowrap">
        {row.original.fundingLevel && <div>{row.original.fundingLevel}</div>}
        {row.original.fundingShare && (
          <div className="text-muted-foreground/70">
            {row.original.fundingShare} of portfolio
          </div>
        )}
        {row.original.recommendedShift && (
          <div className="font-medium text-foreground">
            {row.original.recommendedShift}
          </div>
        )}
      </div>
    ),
  },
];

// ---------------------------------------------------------------------------
// Summary Cards
// ---------------------------------------------------------------------------

function SummaryCards({ summary }: { summary: InterventionSummary }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 not-prose">
      <div className="rounded-lg border bg-card p-3">
        <div className="text-2xl font-bold">{summary.total}</div>
        <div className="text-xs text-muted-foreground">Interventions</div>
      </div>
      <div className="rounded-lg border bg-card p-3">
        <div className="text-2xl font-bold text-red-600 dark:text-red-400">
          {(summary.byPriority["Very High"] || 0) + (summary.byPriority["High"] || 0)}
        </div>
        <div className="text-xs text-muted-foreground">
          High+ priority
        </div>
        <div className="text-[10px] text-muted-foreground/70 mt-0.5">
          {summary.byPriority["Very High"] || 0} very high, {summary.byPriority["High"] || 0} high
        </div>
      </div>
      <div className="rounded-lg border bg-card p-3">
        <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
          {summary.recommendedIncreases}
        </div>
        <div className="text-xs text-muted-foreground">Recommended for increase</div>
      </div>
      <div className="rounded-lg border bg-card p-3">
        <div className="text-xs text-muted-foreground mb-1">Weakest risk coverage</div>
        {summary.riskGaps.slice(0, 2).map((gap) => (
          <div key={gap.risk} className="text-[11px]">
            <span className="capitalize font-medium">{gap.risk}</span>
            <span className="text-muted-foreground/70 ml-1">
              ({gap.coverageCount} intervention{gap.coverageCount !== 1 ? "s" : ""})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category Filter Tabs
// ---------------------------------------------------------------------------

function CategoryFilters({
  categories,
  active,
  onSelect,
}: {
  categories: Record<string, number>;
  active: string | null;
  onSelect: (cat: string | null) => void;
}) {
  const total = Object.values(categories).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-wrap gap-1.5 mb-4 not-prose">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "rounded-full px-3 py-1 text-xs font-medium transition-colors",
          active === null
            ? "bg-foreground text-background"
            : "bg-muted text-muted-foreground hover:bg-muted/80"
        )}
      >
        All ({total})
      </button>
      {Object.entries(categories)
        .sort(([, a], [, b]) => b - a)
        .map(([cat, count]) => (
          <button
            key={cat}
            type="button"
            onClick={() => onSelect(active === cat ? null : cat)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              active === cat
                ? categoryBadge[cat] || "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            )}
          >
            {cat} ({count})
          </button>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded Row
// ---------------------------------------------------------------------------

function ExpandedInterventionRow({ row }: { row: InterventionRow }) {
  return (
    <div className="px-4 py-2 bg-muted/30">
      <InterventionCard
        name={row.name}
        category={row.category}
        description={row.description}
        riskCoverage={row.riskCoverage}
        primaryMechanism={row.primaryMechanism}
        tractability={row.tractability}
        neglectedness={row.neglectedness}
        importance={row.importance}
        overallPriority={row.overallPriority}
        timelineFit={row.timelineFit}
        currentState={row.currentState}
        fundingLevel={row.fundingLevel}
        recommendedShift={row.recommendedShift}
        relatedInterventions={row.relatedInterventions}
        relevantResearch={row.relevantResearch}
        className="my-0 shadow-sm"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function InterventionsTable({
  data,
  summary,
}: {
  data: InterventionRow[];
  summary: InterventionSummary;
}) {
  const [categoryFilter, setCategoryFilter] = React.useState<string | null>(null);
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "overallPriority", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = React.useState("");

  const filteredData = React.useMemo(
    () => (categoryFilter ? data.filter((d) => d.category === categoryFilter) : data),
    [data, categoryFilter]
  );

  const table = useReactTable({
    data: filteredData,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    globalFilterFn: "includesString",
  });

  return (
    <div className="space-y-0">
      <SummaryCards summary={summary} />
      <CategoryFilters
        categories={summary.byCategory}
        active={categoryFilter}
        onSelect={setCategoryFilter}
      />

      {/* Search */}
      <div className="flex items-center gap-4 pb-4 not-prose">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search interventions..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {table.getFilteredRowModel().rows.length} of {filteredData.length} results
        </span>
      </div>

      {/* Table */}
      <div className="not-prose">
        <DataTable
          table={table}
          renderExpandedRow={(row) =>
            row.getIsExpanded() ? (
              <ExpandedInterventionRow row={row.original} />
            ) : null
          }
          getRowClassName={(row) =>
            row.getIsExpanded() ? "bg-muted/20" : ""
          }
        />
      </div>
    </div>
  );
}
