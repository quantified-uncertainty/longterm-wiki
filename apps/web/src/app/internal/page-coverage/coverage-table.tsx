"use client";

import { useState } from "react";
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
import type { PageCoverageItem } from "@/data";

type Status = "green" | "amber" | "red";

const statusColor: Record<Status, string> = {
  green: "text-emerald-600",
  amber: "text-amber-600",
  red: "text-red-400/80",
};

/** Shows "actual/target" with status color, e.g. "7/10" in green or "0/3" in red */
function MetricCell({
  actual,
  target,
  status,
}: {
  actual: number;
  target: number;
  status: Status;
}) {
  return (
    <span className={`text-xs tabular-nums font-medium ${statusColor[status]}`}>
      {actual}
      <span className="text-muted-foreground/40">/{target}</span>
    </span>
  );
}

/** Shows "actual/total" as a ratio metric (quotes, accuracy) */
function RatioCell({
  actual,
  total,
  status,
}: {
  actual: number;
  total: number;
  status: Status;
}) {
  if (total === 0) {
    return <span className="text-xs text-muted-foreground/30">-</span>;
  }
  return (
    <span className={`text-xs tabular-nums font-medium ${statusColor[status]}`}>
      {actual}
      <span className="text-muted-foreground/40">/{total}</span>
    </span>
  );
}

function BoolIcon({ value, label }: { value: boolean; label: string }) {
  return value ? (
    <span className="text-emerald-500 text-xs font-bold" title={label}>
      ✓
    </span>
  ) : (
    <span className="text-muted-foreground/30 text-xs" title={label}>
      ✗
    </span>
  );
}

function ScoreBadge({ score, total }: { score: number; total: number }) {
  const pct = score / total;
  const color =
    pct >= 0.75
      ? "bg-emerald-500/15 text-emerald-600"
      : pct >= 0.5
        ? "bg-amber-500/15 text-amber-600"
        : "bg-red-500/15 text-red-600";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] tabular-nums font-bold ${color}`}
    >
      {score}/{total}
    </span>
  );
}

const qualityThresholds: [number, string][] = [
  [80, "text-emerald-500"],
  [60, "text-blue-500"],
  [40, "text-amber-500"],
  [20, "text-red-500"],
  [0, "text-slate-400/60"],
];

function ScoreValue({
  value,
  thresholds,
}: {
  value: number | null;
  thresholds: [number, string][];
}) {
  if (value == null)
    return <span className="text-muted-foreground/40">-</span>;
  const color =
    thresholds.find(([t]) => value >= t)?.[1] ?? "text-muted-foreground";
  return (
    <span className={`text-xs tabular-nums font-medium ${color}`}>
      {Math.round(value)}
    </span>
  );
}

function statusOrder(s: Status): number {
  return s === "red" ? 0 : s === "amber" ? 1 : 2;
}

/** Human-readable label for the column picker dropdown */
const COLUMN_LABELS: Record<string, string> = {
  title: "Title",
  score: "Score",
  quality: "Quality",
  readerImportance: "Importance",
  contentFormat: "Format",
  wordCount: "Words",
  booleans: "Bool (Summary, Structured, Schedule, Entity, History)",
  tables: "Tables",
  diagrams: "Diagrams",
  internalLinks: "Internal Links",
  externalLinks: "External Links",
  footnotes: "Footnotes",
  references: "References",
  quotes: "Quotes",
  accuracy: "Accuracy",
  category: "Category",
};

const columns: ColumnDef<PageCoverageItem>[] = [
  {
    accessorKey: "title",
    header: ({ column }) => (
      <SortableHeader column={column} title="Page title">
        Title
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <Link
        href={`/wiki/${row.original.numericId}`}
        className="text-sm font-medium text-accent-foreground hover:underline no-underline"
      >
        {row.original.title}
      </Link>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "score",
    header: ({ column }) => (
      <SortableHeader
        column={column}
        title="Coverage score: passing items out of 13 total (5 boolean + 8 numeric)"
      >
        Score
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <ScoreBadge score={row.original.score} total={row.original.total} />
    ),
  },
  {
    accessorKey: "quality",
    header: ({ column }) => (
      <SortableHeader column={column} title="Quality score (0–100)">
        Quality
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <ScoreValue
        value={row.original.quality}
        thresholds={qualityThresholds}
      />
    ),
  },
  {
    accessorKey: "readerImportance",
    sortUndefined: "last",
    header: ({ column }) => (
      <SortableHeader column={column} title="Reader importance score (0–100)">
        Imp
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <ScoreValue
        value={row.original.readerImportance}
        thresholds={qualityThresholds}
      />
    ),
  },
  {
    accessorKey: "contentFormat",
    header: ({ column }) => (
      <SortableHeader column={column} title="Content format (article, analysis, etc.)">
        Format
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.contentFormat}
      </span>
    ),
  },
  {
    accessorKey: "wordCount",
    header: ({ column }) => (
      <SortableHeader column={column} title="Word count">
        Words
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const wc = row.original.wordCount;
      return (
        <span className="text-xs tabular-nums text-muted-foreground">
          {wc >= 1000 ? `${(wc / 1000).toFixed(1)}k` : wc}
        </span>
      );
    },
  },
  {
    id: "booleans",
    header: () => (
      <span
        className="text-xs font-medium cursor-help"
        title="Boolean checks: LLM Summary, Structured Summary, Update Schedule, Entity, Edit History"
      >
        Bool
      </span>
    ),
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-1">
        <BoolIcon value={row.original.llmSummary} label="LLM Summary" />
        <BoolIcon value={row.original.structuredSummary} label="Structured Summary" />
        <BoolIcon value={row.original.schedule} label="Update Schedule" />
        <BoolIcon value={row.original.entity} label="Entity" />
        <BoolIcon value={row.original.editHistory} label="Edit History" />
      </span>
    ),
  },
  {
    id: "tables",
    accessorKey: "tablesActual",
    header: ({ column }) => (
      <SortableHeader column={column} title="Tables: actual count / recommended target">
        Tbl
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <MetricCell
        actual={row.original.tablesActual}
        target={row.original.tablesTarget}
        status={row.original.tables}
      />
    ),
  },
  {
    id: "diagrams",
    accessorKey: "diagramsActual",
    header: ({ column }) => (
      <SortableHeader column={column} title="Diagrams: actual count / recommended target">
        Dia
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <MetricCell
        actual={row.original.diagramsActual}
        target={row.original.diagramsTarget}
        status={row.original.diagrams}
      />
    ),
  },
  {
    id: "internalLinks",
    accessorKey: "internalLinksActual",
    header: ({ column }) => (
      <SortableHeader column={column} title="Internal links: actual / recommended target">
        Int
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <MetricCell
        actual={row.original.internalLinksActual}
        target={row.original.internalLinksTarget}
        status={row.original.internalLinks}
      />
    ),
  },
  {
    id: "externalLinks",
    accessorKey: "externalLinksActual",
    header: ({ column }) => (
      <SortableHeader column={column} title="External links: actual / recommended target">
        Ext
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <MetricCell
        actual={row.original.externalLinksActual}
        target={row.original.externalLinksTarget}
        status={row.original.externalLinks}
      />
    ),
  },
  {
    id: "footnotes",
    accessorKey: "footnotesActual",
    header: ({ column }) => (
      <SortableHeader column={column} title="Footnotes: actual / recommended target">
        Fn
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <MetricCell
        actual={row.original.footnotesActual}
        target={row.original.footnotesTarget}
        status={row.original.footnotes}
      />
    ),
  },
  {
    id: "references",
    accessorKey: "referencesActual",
    header: ({ column }) => (
      <SortableHeader column={column} title="Resource references: actual / recommended target">
        Ref
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <MetricCell
        actual={row.original.referencesActual}
        target={row.original.referencesTarget}
        status={row.original.references}
      />
    ),
  },
  {
    id: "quotes",
    accessorKey: "quotesActual",
    header: ({ column }) => (
      <SortableHeader column={column} title="Citations with supporting quotes: verified / total citations (≥75% = green)">
        Qt
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <RatioCell
        actual={row.original.quotesActual}
        total={row.original.quotesTotal}
        status={row.original.quotes}
      />
    ),
  },
  {
    id: "accuracy",
    accessorKey: "accuracyActual",
    header: ({ column }) => (
      <SortableHeader column={column} title="Accuracy verified citations: checked / total citations (≥75% = green)">
        Acc
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <RatioCell
        actual={row.original.accuracyActual}
        total={row.original.accuracyTotal}
        status={row.original.accuracy}
      />
    ),
  },
  {
    accessorKey: "category",
    header: ({ column }) => (
      <SortableHeader column={column} title="Page category / entity type">
        Category
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">
        {row.original.category}
      </span>
    ),
  },
];

const DEFAULT_HIDDEN: VisibilityState = {
  contentFormat: false,
  category: false,
};

export function CoverageTable({ data }: { data: PageCoverageItem[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "score", desc: false },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] =
    useState<VisibilityState>(DEFAULT_HIDDEN);
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    globalFilterFn: "includesString",
    state: {
      sorting,
      globalFilter,
      columnVisibility,
    },
  });

  const filtered = table.getFilteredRowModel().rows.length;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            placeholder="Search pages..."
            value={globalFilter ?? ""}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>

        {/* Column picker */}
        <div className="relative">
          <button
            onClick={() => setShowColumnPicker((v) => !v)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-border rounded-md bg-background text-muted-foreground hover:bg-muted transition-colors"
          >
            <Columns3 className="h-3.5 w-3.5" />
            Columns
          </button>
          {showColumnPicker && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-2 min-w-[220px]">
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
                  {COLUMN_LABELS[col.id] ?? col.id}
                </label>
              ))}
            </div>
          )}
        </div>

        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filtered === data.length
            ? `${data.length} pages`
            : `${filtered} of ${data.length} pages`}
        </span>
      </div>

      {/* Table */}
      <DataTable table={table} />
    </div>
  );
}
