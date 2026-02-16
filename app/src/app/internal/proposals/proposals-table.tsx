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
import { ProposalCard } from "@/components/wiki/ProposalCard";
import {
  domainBadge,
  stanceBadge,
  feasibilityColor,
  statusLabel,
} from "@/components/wiki/badge-styles";
import { cn } from "@lib/utils";
import { ChevronRight, Search } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProposalRow {
  id: string;
  name: string;
  description: string;
  domain: string;
  stance: string;
  costEstimate: string;
  evEstimate: string;
  feasibility: string;
  honestConcerns: string;
  status: string;
  sourcePageHref: string | null;
  sourcePageId: string;
  leadOrganizations: string[];
  relatedProposals: string[];
  leverage: number | null; // EV midpoint / cost midpoint
  leverageLabel: string;
}

export interface ProposalSummary {
  total: number;
  byDomain: Record<string, number>;
  byStatus: Record<string, number>;
  byStance: Record<string, number>;
  topLeverage: Array<{ name: string; leverageLabel: string }>;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const FEASIBILITY_ORDER: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const columns: ColumnDef<ProposalRow>[] = [
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
      <SortableHeader column={column}>Proposal</SortableHeader>
    ),
    cell: ({ row }) => (
      <div className="min-w-[180px]">
        <span className="text-sm font-medium">{row.original.name}</span>
        <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2 leading-relaxed max-w-[300px]">
          {row.original.description}
        </p>
      </div>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "domain",
    header: ({ column }) => (
      <SortableHeader column={column}>Domain</SortableHeader>
    ),
    cell: ({ row }) => {
      const d = row.original.domain;
      return (
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
            domainBadge[d] || domainBadge.governance
          )}
        >
          {d}
        </span>
      );
    },
  },
  {
    accessorKey: "stance",
    header: ({ column }) => (
      <SortableHeader column={column}>Stance</SortableHeader>
    ),
    cell: ({ row }) => {
      const s = row.original.stance;
      return (
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
            stanceBadge[s] || stanceBadge.neutral
          )}
        >
          {s}
        </span>
      );
    },
  },
  {
    accessorKey: "feasibility",
    header: ({ column }) => (
      <SortableHeader column={column}>Feasibility</SortableHeader>
    ),
    cell: ({ row }) => {
      const f = row.original.feasibility;
      return (
        <span
          className={cn(
            "text-xs font-medium whitespace-nowrap",
            feasibilityColor[f] || ""
          )}
        >
          {f}
        </span>
      );
    },
    sortingFn: (a, b) =>
      (FEASIBILITY_ORDER[a.original.feasibility] || 0) -
      (FEASIBILITY_ORDER[b.original.feasibility] || 0),
  },
  {
    accessorKey: "status",
    header: ({ column }) => (
      <SortableHeader column={column}>Status</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {statusLabel[row.original.status] || row.original.status}
      </span>
    ),
  },
  {
    id: "economics",
    header: "Cost / EV",
    cell: ({ row }) => (
      <div className="text-[11px] text-muted-foreground whitespace-nowrap">
        {row.original.costEstimate && (
          <div>
            Cost: <strong>{row.original.costEstimate}</strong>
          </div>
        )}
        {row.original.evEstimate && (
          <div>
            EV: <strong>{row.original.evEstimate}</strong>
          </div>
        )}
      </div>
    ),
  },
  {
    accessorKey: "leverage",
    header: ({ column }) => (
      <SortableHeader column={column}>Leverage</SortableHeader>
    ),
    cell: ({ row }) => {
      const lev = row.original.leverage;
      return (
        <span
          className={cn(
            "text-xs font-medium tabular-nums whitespace-nowrap",
            lev !== null && lev >= 100
              ? "text-green-700 dark:text-green-400"
              : lev !== null && lev >= 10
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground"
          )}
        >
          {row.original.leverageLabel}
        </span>
      );
    },
    sortingFn: (a, b) => (a.original.leverage ?? -1) - (b.original.leverage ?? -1),
  },
  {
    accessorKey: "sourcePageId",
    header: "Source",
    cell: ({ row }) =>
      row.original.sourcePageHref ? (
        <Link
          href={row.original.sourcePageHref}
          className="text-[11px] text-accent-foreground hover:underline no-underline whitespace-nowrap"
        >
          {row.original.sourcePageId}
        </Link>
      ) : (
        <span className="text-[11px] text-muted-foreground">
          {row.original.sourcePageId}
        </span>
      ),
  },
];

// ---------------------------------------------------------------------------
// Summary Cards
// ---------------------------------------------------------------------------

function SummaryCards({ summary }: { summary: ProposalSummary }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 not-prose">
      <div className="rounded-lg border bg-card p-3">
        <div className="text-2xl font-bold">{summary.total}</div>
        <div className="text-xs text-muted-foreground">Proposals</div>
        <div className="text-[10px] text-muted-foreground/70 mt-0.5">
          {Object.entries(summary.byStatus)
            .sort(([, a], [, b]) => b - a)
            .map(([s, n]) => `${n} ${statusLabel[s] || s}`)
            .join(", ")}
        </div>
      </div>
      <div className="rounded-lg border bg-card p-3">
        <div className="flex gap-3 text-sm">
          {Object.entries(summary.byStance)
            .sort(([, a], [, b]) => b - a)
            .map(([stance, count]) => (
              <div key={stance}>
                <span
                  className={cn(
                    "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium mr-1",
                    stanceBadge[stance] || stanceBadge.neutral
                  )}
                >
                  {stance}
                </span>
                <span className="font-bold">{count}</span>
              </div>
            ))}
        </div>
        <div className="text-xs text-muted-foreground mt-1">By stance</div>
      </div>
      <div className="rounded-lg border bg-card p-3">
        <div className="text-xs text-muted-foreground mb-1">Highest leverage</div>
        {summary.topLeverage.slice(0, 3).map((p, i) => (
          <div key={i} className="text-[11px] truncate">
            <span className="font-medium text-green-700 dark:text-green-400 mr-1">
              {p.leverageLabel}
            </span>
            <span className="text-muted-foreground">{p.name}</span>
          </div>
        ))}
      </div>
      <div className="rounded-lg border bg-card p-3">
        <div className="text-xs text-muted-foreground mb-1">Top domains</div>
        {Object.entries(summary.byDomain)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3)
          .map(([domain, count]) => (
            <div key={domain} className="text-[11px]">
              <span className="capitalize font-medium">{domain}</span>
              <span className="text-muted-foreground/70 ml-1">({count})</span>
            </div>
          ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Domain Filter Tabs
// ---------------------------------------------------------------------------

function DomainFilters({
  domains,
  active,
  onSelect,
}: {
  domains: Record<string, number>;
  active: string | null;
  onSelect: (d: string | null) => void;
}) {
  const total = Object.values(domains).reduce((a, b) => a + b, 0);

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
      {Object.entries(domains)
        .sort(([, a], [, b]) => b - a)
        .map(([domain, count]) => (
          <button
            key={domain}
            type="button"
            onClick={() => onSelect(active === domain ? null : domain)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              active === domain
                ? domainBadge[domain] || "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            )}
          >
            {domain} ({count})
          </button>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expanded Row
// ---------------------------------------------------------------------------

function ExpandedProposalRow({ row }: { row: ProposalRow }) {
  return (
    <div className="px-4 py-2 bg-muted/30">
      <ProposalCard
        name={row.name}
        description={row.description}
        domain={row.domain}
        stance={row.stance}
        costEstimate={row.costEstimate}
        evEstimate={row.evEstimate}
        feasibility={row.feasibility}
        honestConcerns={row.honestConcerns}
        status={row.status}
        leadOrganizations={row.leadOrganizations}
        relatedProposals={row.relatedProposals}
        className="my-0 shadow-sm"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function ProposalsTable({
  data,
  summary,
}: {
  data: ProposalRow[];
  summary: ProposalSummary;
}) {
  const [domainFilter, setDomainFilter] = React.useState<string | null>(null);
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "leverage", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = React.useState("");

  const filteredData = React.useMemo(
    () =>
      domainFilter ? data.filter((d) => d.domain === domainFilter) : data,
    [data, domainFilter]
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
      <DomainFilters
        domains={summary.byDomain}
        active={domainFilter}
        onSelect={setDomainFilter}
      />

      {/* Search */}
      <div className="flex items-center gap-4 pb-4 not-prose">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search proposals..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {table.getFilteredRowModel().rows.length} of {filteredData.length}{" "}
          results
        </span>
      </div>

      {/* Table */}
      <div className="not-prose">
        <DataTable
          table={table}
          renderExpandedRow={(row) =>
            row.getIsExpanded() ? (
              <ExpandedProposalRow row={row.original} />
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
