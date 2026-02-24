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

function StatusDot({ status }: { status: Status }) {
  const color =
    status === "green"
      ? "bg-emerald-500"
      : status === "amber"
        ? "bg-amber-500"
        : "bg-red-400/60";
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
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
        Importance
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
    accessorKey: "tables",
    header: ({ column }) => (
      <SortableHeader column={column} title="Tables: green if meets target, amber if some present, red if none">
        Tbl
      </SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.tables} />,
    sortingFn: (a, b) =>
      statusOrder(a.original.tables) - statusOrder(b.original.tables),
  },
  {
    id: "diagrams",
    accessorKey: "diagrams",
    header: ({ column }) => (
      <SortableHeader column={column} title="Diagrams: green if meets target, amber if some present, red if none">
        Dia
      </SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.diagrams} />,
    sortingFn: (a, b) =>
      statusOrder(a.original.diagrams) - statusOrder(b.original.diagrams),
  },
  {
    id: "internalLinks",
    accessorKey: "internalLinks",
    header: ({ column }) => (
      <SortableHeader column={column} title="Internal links to other wiki pages">
        Int
      </SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.internalLinks} />,
    sortingFn: (a, b) =>
      statusOrder(a.original.internalLinks) -
      statusOrder(b.original.internalLinks),
  },
  {
    id: "externalLinks",
    accessorKey: "externalLinks",
    header: ({ column }) => (
      <SortableHeader column={column} title="External links to outside sources">
        Ext
      </SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.externalLinks} />,
    sortingFn: (a, b) =>
      statusOrder(a.original.externalLinks) -
      statusOrder(b.original.externalLinks),
  },
  {
    id: "footnotes",
    accessorKey: "footnotes",
    header: ({ column }) => (
      <SortableHeader column={column} title="Footnotes / inline citations">
        Fn
      </SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.footnotes} />,
    sortingFn: (a, b) =>
      statusOrder(a.original.footnotes) - statusOrder(b.original.footnotes),
  },
  {
    id: "references",
    accessorKey: "references",
    header: ({ column }) => (
      <SortableHeader column={column} title="External resource references">
        Ref
      </SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.references} />,
    sortingFn: (a, b) =>
      statusOrder(a.original.references) - statusOrder(b.original.references),
  },
  {
    id: "quotes",
    accessorKey: "quotes",
    header: ({ column }) => (
      <SortableHeader column={column} title="Citations with supporting quotes (≥75% = green)">
        Qt
      </SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.quotes} />,
    sortingFn: (a, b) =>
      statusOrder(a.original.quotes) - statusOrder(b.original.quotes),
  },
  {
    id: "accuracy",
    accessorKey: "accuracy",
    header: ({ column }) => (
      <SortableHeader column={column} title="Citations with accuracy verification (≥75% = green)">
        Acc
      </SortableHeader>
    ),
    cell: ({ row }) => <StatusDot status={row.original.accuracy} />,
    sortingFn: (a, b) =>
      statusOrder(a.original.accuracy) - statusOrder(b.original.accuracy),
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
