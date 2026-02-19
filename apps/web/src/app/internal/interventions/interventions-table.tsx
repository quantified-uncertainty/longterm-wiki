"use client";

import * as React from "react";
import Link from "next/link";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getExpandedRowModel,
} from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import { expandToggleColumn } from "@/components/tables/shared/column-helpers";
import { InterventionCard } from "@/components/wiki/InterventionCard";
import {
  priorityBadge,
  categoryBadge,
  coverageColor,
  itnLabel,
} from "@/components/wiki/badge-styles";
import { cn } from "@lib/utils";
import { FilterTabs, TableSearchBar } from "../shared";

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
  expandToggleColumn<InterventionRow>(),
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
        <div className="text-xs text-muted-foreground">High+ priority</div>
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
      <FilterTabs
        counts={summary.byCategory}
        active={categoryFilter}
        onSelect={setCategoryFilter}
        badgeStyles={categoryBadge}
      />
      <TableSearchBar
        value={globalFilter}
        onChange={setGlobalFilter}
        placeholder="Search interventions..."
        resultCount={table.getFilteredRowModel().rows.length}
        totalCount={filteredData.length}
      />

      <div className="not-prose">
        <DataTable
          table={table}
          renderExpandedRow={(row) =>
            row.getIsExpanded() ? (
              <div className="px-4 py-2 bg-muted/30">
                <InterventionCard
                  name={row.original.name}
                  category={row.original.category}
                  description={row.original.description}
                  riskCoverage={row.original.riskCoverage}
                  primaryMechanism={row.original.primaryMechanism}
                  tractability={row.original.tractability}
                  neglectedness={row.original.neglectedness}
                  importance={row.original.importance}
                  overallPriority={row.original.overallPriority}
                  timelineFit={row.original.timelineFit}
                  currentState={row.original.currentState}
                  fundingLevel={row.original.fundingLevel}
                  recommendedShift={row.original.recommendedShift}
                  relatedInterventions={row.original.relatedInterventions}
                  relevantResearch={row.original.relevantResearch}
                  className="my-0 shadow-sm"
                />
              </div>
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
