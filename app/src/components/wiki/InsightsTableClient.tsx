"use client";

import * as React from "react";
import Link from "next/link";
import type { ColumnDef, SortingState, ColumnFiltersState } from "@tanstack/react-table";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search } from "lucide-react";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import type { InsightItem } from "@/data";

const TYPE_LABELS: Record<string, string> = {
  claim: "Claim",
  "research-gap": "Research Gap",
  counterintuitive: "Counterintuitive",
  quantitative: "Quantitative",
  disagreement: "Disagreement",
  neglected: "Neglected",
};

const TYPE_COLORS: Record<string, string> = {
  claim: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "research-gap": "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  counterintuitive: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  quantitative: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  disagreement: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  neglected: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300",
};

function ScoreBadge({ value }: { value: number }) {
  const color =
    value >= 4
      ? "text-emerald-600 dark:text-emerald-400 font-semibold"
      : value >= 3
        ? "text-amber-600 dark:text-amber-400 font-medium"
        : "text-muted-foreground";
  return <span className={`text-xs tabular-nums ${color}`}>{value.toFixed(1)}</span>;
}

/** Format a source path into a short readable label */
function formatSourceLabel(href: string, title: string | null): string {
  if (title) return title;
  return href
    .replace(/^\/knowledge-base\//, "")
    .replace(/^\/ai-transition-model\//, "ATM: ")
    .replace(/\/$/, "")
    .split("/")
    .pop() || href;
}

/** Context to let tag cells set the global filter */
const SetFilterContext = React.createContext<(tag: string) => void>(() => {});

function makeColumns(): ColumnDef<InsightItem>[] {
  return [
    {
      accessorKey: "insight",
      header: ({ column }) => (
        <SortableHeader column={column}>Insight</SortableHeader>
      ),
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="py-1">
            <p className="text-sm leading-relaxed text-foreground">{item.insight}</p>
            <Link
              href={item.sourceHref}
              className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline no-underline mt-1 inline-block"
            >
              → {formatSourceLabel(item.sourceHref, item.sourceTitle)}
            </Link>
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
        const type = row.original.type;
        return (
          <span
            className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap ${TYPE_COLORS[type] || ""}`}
          >
            {TYPE_LABELS[type] || type}
          </span>
        );
      },
      size: 90,
    },
    {
      accessorKey: "composite",
      header: ({ column }) => (
        <SortableHeader column={column}>Score</SortableHeader>
      ),
      cell: ({ row }) => <ScoreBadge value={row.original.composite} />,
      size: 52,
    },
    {
      accessorKey: "surprising",
      header: ({ column }) => (
        <SortableHeader column={column}>Surp.</SortableHeader>
      ),
      cell: ({ row }) => <ScoreBadge value={row.original.surprising} />,
      size: 52,
    },
    {
      accessorKey: "important",
      header: ({ column }) => (
        <SortableHeader column={column}>Imp.</SortableHeader>
      ),
      cell: ({ row }) => <ScoreBadge value={row.original.important} />,
      size: 52,
    },
    {
      accessorKey: "actionable",
      header: ({ column }) => (
        <SortableHeader column={column}>Act.</SortableHeader>
      ),
      cell: ({ row }) => <ScoreBadge value={row.original.actionable} />,
      size: 52,
    },
    {
      accessorKey: "neglected",
      header: ({ column }) => (
        <SortableHeader column={column}>Negl.</SortableHeader>
      ),
      cell: ({ row }) => <ScoreBadge value={row.original.neglected} />,
      size: 52,
    },
    {
      accessorKey: "compact",
      header: ({ column }) => (
        <SortableHeader column={column}>Comp.</SortableHeader>
      ),
      cell: ({ row }) => <ScoreBadge value={row.original.compact} />,
      size: 52,
    },
    {
      accessorKey: "tags",
      header: () => <span className="text-xs">Tags</span>,
      cell: ({ row }) => <TagCell tags={row.original.tags} />,
      enableSorting: false,
      size: 120,
    },
  ];
}

function TagCell({ tags }: { tags: string[] }) {
  const setFilter = React.useContext(SetFilterContext);
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.slice(0, 3).map((tag, i) => (
        <button
          key={`${tag}-${i}`}
          type="button"
          onClick={() => setFilter(tag)}
          className="text-[9px] px-1 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded hover:bg-blue-100 hover:text-blue-700 dark:hover:bg-blue-900/40 dark:hover:text-blue-300 cursor-pointer transition-colors"
        >
          {tag}
        </button>
      ))}
      {tags.length > 3 && (
        <span className="text-[9px] text-muted-foreground">
          +{tags.length - 3}
        </span>
      )}
    </div>
  );
}

const columns = makeColumns();

export function InsightsTableClient({ data }: { data: InsightItem[] }) {
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "composite", desc: true },
  ]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = React.useState("");

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    onColumnFiltersChange: setColumnFilters,
    getFilteredRowModel: getFilteredRowModel(),
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    state: { sorting, columnFilters, globalFilter },
  });

  return (
    <SetFilterContext.Provider value={setGlobalFilter}>
      <div className="space-y-4">
        {/* Search */}
        <div className="flex items-center gap-4 pb-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              placeholder="Search insights..."
              value={globalFilter ?? ""}
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="h-10 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
          </div>
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {table.getFilteredRowModel().rows.length} of {data.length} results
          </span>
        </div>

        {/* Table */}
        <DataTable table={table} />
      </div>
    </SetFilterContext.Provider>
  );
}
