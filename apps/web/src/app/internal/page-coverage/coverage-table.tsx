"use client";

import { useState, useCallback } from "react";
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

// ---------------------------------------------------------------------------
// Reusable cell renderers
// ---------------------------------------------------------------------------

const statusColor: Record<Status, string> = {
  green: "text-emerald-600",
  amber: "text-amber-600",
  red: "text-red-400/80",
};

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
    <span className="text-emerald-500 text-xs font-bold" title={label}>✓</span>
  ) : (
    <span className="text-muted-foreground/30 text-xs" title={label}>✗</span>
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
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] tabular-nums font-bold ${color}`}>
      {score}/{total}
    </span>
  );
}

const scoreThresholds: [number, string][] = [
  [80, "text-emerald-500"],
  [60, "text-blue-500"],
  [40, "text-amber-500"],
  [20, "text-red-500"],
  [0, "text-slate-400/60"],
];

const ratingThresholds: [number, string][] = [
  [8, "text-emerald-500"],
  [6, "text-blue-500"],
  [4, "text-amber-500"],
  [2, "text-red-500"],
  [0, "text-slate-400/60"],
];

function NumericCell({
  value,
  thresholds,
}: {
  value: number | null;
  thresholds: [number, string][];
}) {
  if (value == null) return <span className="text-muted-foreground/30">-</span>;
  const color = thresholds.find(([t]) => value >= t)?.[1] ?? "text-muted-foreground";
  return (
    <span className={`text-xs tabular-nums font-medium ${color}`}>
      {Math.round(value)}
    </span>
  );
}

function RiskBadge({ level }: { level: "low" | "medium" | "high" | null }) {
  if (!level) return <span className="text-muted-foreground/30 text-xs">-</span>;
  const styles: Record<string, string> = {
    low: "bg-emerald-500/15 text-emerald-600",
    medium: "bg-amber-500/15 text-amber-600",
    high: "bg-red-500/15 text-red-600",
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${styles[level]}`}>
      {level}
    </span>
  );
}

function DateCell({ date }: { date: string | null }) {
  if (!date) return <span className="text-muted-foreground/30 text-xs">-</span>;
  const d = new Date(date);
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  const label = days <= 7 ? `${days}d` : days <= 60 ? `${Math.round(days / 7)}w` : `${Math.round(days / 30)}mo`;
  const color = days <= 30 ? "text-emerald-600" : days <= 90 ? "text-blue-500" : days <= 180 ? "text-amber-500" : "text-red-400";
  return (
    <span className={`text-xs tabular-nums ${color}`} title={date}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Column definitions — ALL possible columns
// ---------------------------------------------------------------------------

/** Human-readable labels for the column picker */
const COLUMN_LABELS: Record<string, string> = {
  title: "Title",
  quality: "Quality",
  readerImportance: "Reader Importance",
  researchImportance: "Research Importance",
  tacticalValue: "Tactical Value",
  score: "Coverage Score",
  contentFormat: "Format",
  wordCount: "Words",
  entityType: "Entity Type",
  category: "Category",
  subcategory: "Subcategory",
  riskLevel: "Hallucination Risk",
  riskScore: "Risk Score",
  lastUpdated: "Last Updated",
  updateFrequency: "Update Freq (days)",
  novelty: "Novelty",
  rigor: "Rigor",
  actionability: "Actionability",
  completeness: "Completeness",
  citationTotal: "Citations Total",
  citationWithQuotes: "Citations w/ Quotes",
  citationAccuracyChecked: "Citations Checked",
  citationAvgScore: "Avg Accuracy Score",
  backlinkCount: "Backlinks",
  sectionCount: "Sections",
  unconvertedLinkCount: "Unconverted Links",
  booleans: "Bool (Summary, Structured, Schedule, Entity, History)",
  tables: "Tables",
  diagrams: "Diagrams",
  internalLinks: "Internal Links",
  externalLinks: "External Links",
  footnotes: "Footnotes",
  references: "References",
  quotes: "Quotes Verified",
  accuracy: "Accuracy Verified",
};

const columns: ColumnDef<PageCoverageItem>[] = [
  // --- Core ---
  {
    accessorKey: "title",
    header: ({ column }) => <SortableHeader column={column} title="Page title">Title</SortableHeader>,
    cell: ({ row }) => (
      <Link href={`/wiki/${row.original.numericId}`} className="text-sm font-medium text-accent-foreground hover:underline no-underline max-w-[200px] truncate block">
        {row.original.title}
      </Link>
    ),
    filterFn: "includesString",
    size: 200,
  },

  // --- Quality & Importance ---
  {
    accessorKey: "quality",
    header: ({ column }) => <SortableHeader column={column} title="Quality score (0–100)">Qual</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.quality} thresholds={scoreThresholds} />,
  },
  {
    accessorKey: "readerImportance",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Reader importance (0–100)">Imp</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.readerImportance} thresholds={scoreThresholds} />,
  },
  {
    accessorKey: "researchImportance",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Research importance (0–100)">Res</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.researchImportance} thresholds={scoreThresholds} />,
  },
  {
    accessorKey: "tacticalValue",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Tactical / shareability value (0–100)">Tact</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.tacticalValue} thresholds={scoreThresholds} />,
  },

  // --- Coverage ---
  {
    accessorKey: "score",
    header: ({ column }) => <SortableHeader column={column} title="Coverage: passing items out of 13 (5 bool + 8 numeric)">Cov</SortableHeader>,
    cell: ({ row }) => <ScoreBadge score={row.original.score} total={row.original.total} />,
  },

  // --- Risk ---
  {
    id: "riskLevel",
    accessorKey: "riskLevel",
    header: ({ column }) => <SortableHeader column={column} title="Hallucination risk level">Risk</SortableHeader>,
    cell: ({ row }) => <RiskBadge level={row.original.riskLevel} />,
    sortingFn: (a, b) => {
      const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
      return (order[a.original.riskLevel ?? ""] ?? 3) - (order[b.original.riskLevel ?? ""] ?? 3);
    },
  },
  {
    accessorKey: "riskScore",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Hallucination risk score (0–100, higher = riskier)">RiskN</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.riskScore;
      if (v == null) return <span className="text-muted-foreground/30 text-xs">-</span>;
      const color = v >= 70 ? "text-red-500" : v >= 40 ? "text-amber-500" : "text-emerald-500";
      return <span className={`text-xs tabular-nums font-medium ${color}`}>{Math.round(v)}</span>;
    },
  },

  // --- Temporal ---
  {
    accessorKey: "lastUpdated",
    header: ({ column }) => <SortableHeader column={column} title="Time since last update">Updated</SortableHeader>,
    cell: ({ row }) => <DateCell date={row.original.lastUpdated} />,
  },
  {
    accessorKey: "updateFrequency",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Target update frequency in days">Freq</SortableHeader>,
    cell: ({ row }) => {
      const f = row.original.updateFrequency;
      if (f == null) return <span className="text-muted-foreground/30 text-xs">-</span>;
      return <span className="text-xs tabular-nums text-muted-foreground">{f}d</span>;
    },
  },

  // --- Classification ---
  {
    accessorKey: "contentFormat",
    header: ({ column }) => <SortableHeader column={column} title="Content format">Fmt</SortableHeader>,
    cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.contentFormat}</span>,
  },
  {
    accessorKey: "wordCount",
    header: ({ column }) => <SortableHeader column={column} title="Word count">Words</SortableHeader>,
    cell: ({ row }) => {
      const wc = row.original.wordCount;
      return <span className="text-xs tabular-nums text-muted-foreground">{wc >= 1000 ? `${(wc / 1000).toFixed(1)}k` : wc}</span>;
    },
  },
  {
    accessorKey: "entityType",
    header: ({ column }) => <SortableHeader column={column} title="Entity type (person, org, risk, etc.)">Type</SortableHeader>,
    cell: ({ row }) => {
      const t = row.original.entityType;
      return t ? <span className="text-xs text-muted-foreground">{t}</span> : <span className="text-muted-foreground/30 text-xs">-</span>;
    },
  },
  {
    accessorKey: "category",
    header: ({ column }) => <SortableHeader column={column} title="Page category">Cat</SortableHeader>,
    cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.category}</span>,
  },
  {
    accessorKey: "subcategory",
    header: ({ column }) => <SortableHeader column={column} title="Page subcategory">Sub</SortableHeader>,
    cell: ({ row }) => {
      const s = row.original.subcategory;
      return s ? <span className="text-xs text-muted-foreground">{s}</span> : <span className="text-muted-foreground/30 text-xs">-</span>;
    },
  },

  // --- Ratings (1–10) ---
  {
    accessorKey: "novelty",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Novelty rating (1–10)">Nov</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.novelty} thresholds={ratingThresholds} />,
  },
  {
    accessorKey: "rigor",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Rigor rating (1–10)">Rig</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.rigor} thresholds={ratingThresholds} />,
  },
  {
    accessorKey: "actionability",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Actionability rating (1–10)">Act</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.actionability} thresholds={ratingThresholds} />,
  },
  {
    accessorKey: "completeness",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Completeness rating (1–10)">Comp</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.completeness} thresholds={ratingThresholds} />,
  },

  // --- Citation health ---
  {
    accessorKey: "citationTotal",
    header: ({ column }) => <SortableHeader column={column} title="Total citations on this page">Cit</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.citationTotal;
      return v > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{v}</span> : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
  },
  {
    accessorKey: "citationWithQuotes",
    header: ({ column }) => <SortableHeader column={column} title="Citations with supporting quotes">CitQ</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.citationWithQuotes;
      return v > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{v}</span> : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
  },
  {
    accessorKey: "citationAccuracyChecked",
    header: ({ column }) => <SortableHeader column={column} title="Citations with accuracy verification">CitA</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.citationAccuracyChecked;
      return v > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{v}</span> : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
  },
  {
    accessorKey: "citationAvgScore",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Average citation accuracy score">AvgA</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.citationAvgScore;
      if (v == null) return <span className="text-muted-foreground/30 text-xs">-</span>;
      const color = v >= 0.8 ? "text-emerald-500" : v >= 0.5 ? "text-amber-500" : "text-red-400";
      return <span className={`text-xs tabular-nums font-medium ${color}`}>{(v * 100).toFixed(0)}%</span>;
    },
  },

  // --- Structural ---
  {
    accessorKey: "backlinkCount",
    header: ({ column }) => <SortableHeader column={column} title="Pages linking to this page">BL</SortableHeader>,
    cell: ({ row }) => <span className="text-xs tabular-nums text-muted-foreground">{row.original.backlinkCount}</span>,
  },
  {
    accessorKey: "sectionCount",
    header: ({ column }) => <SortableHeader column={column} title="Number of sections">Sec</SortableHeader>,
    cell: ({ row }) => <span className="text-xs tabular-nums text-muted-foreground">{row.original.sectionCount}</span>,
  },
  {
    accessorKey: "unconvertedLinkCount",
    header: ({ column }) => <SortableHeader column={column} title="Markdown links that should be EntityLinks">Unconv</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.unconvertedLinkCount;
      return v > 0
        ? <span className="text-xs tabular-nums text-amber-500">{v}</span>
        : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
  },

  // --- Boolean items ---
  {
    id: "booleans",
    header: () => (
      <span className="text-xs font-medium cursor-help" title="Boolean checks: LLM Summary, Structured Summary, Update Schedule, Entity, Edit History">
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

  // --- Coverage metrics (actual/target) ---
  {
    id: "tables",
    accessorKey: "tablesActual",
    header: ({ column }) => <SortableHeader column={column} title="Tables: actual / target">Tbl</SortableHeader>,
    cell: ({ row }) => <MetricCell actual={row.original.tablesActual} target={row.original.tablesTarget} status={row.original.tables} />,
  },
  {
    id: "diagrams",
    accessorKey: "diagramsActual",
    header: ({ column }) => <SortableHeader column={column} title="Diagrams: actual / target">Dia</SortableHeader>,
    cell: ({ row }) => <MetricCell actual={row.original.diagramsActual} target={row.original.diagramsTarget} status={row.original.diagrams} />,
  },
  {
    id: "internalLinks",
    accessorKey: "internalLinksActual",
    header: ({ column }) => <SortableHeader column={column} title="Internal links: actual / target">Int</SortableHeader>,
    cell: ({ row }) => <MetricCell actual={row.original.internalLinksActual} target={row.original.internalLinksTarget} status={row.original.internalLinks} />,
  },
  {
    id: "externalLinks",
    accessorKey: "externalLinksActual",
    header: ({ column }) => <SortableHeader column={column} title="External links: actual / target">Ext</SortableHeader>,
    cell: ({ row }) => <MetricCell actual={row.original.externalLinksActual} target={row.original.externalLinksTarget} status={row.original.externalLinks} />,
  },
  {
    id: "footnotes",
    accessorKey: "footnotesActual",
    header: ({ column }) => <SortableHeader column={column} title="Footnotes: actual / target">Fn</SortableHeader>,
    cell: ({ row }) => <MetricCell actual={row.original.footnotesActual} target={row.original.footnotesTarget} status={row.original.footnotes} />,
  },
  {
    id: "references",
    accessorKey: "referencesActual",
    header: ({ column }) => <SortableHeader column={column} title="Resource references: actual / target">Ref</SortableHeader>,
    cell: ({ row }) => <MetricCell actual={row.original.referencesActual} target={row.original.referencesTarget} status={row.original.references} />,
  },
  {
    id: "quotes",
    accessorKey: "quotesActual",
    header: ({ column }) => <SortableHeader column={column} title="Citations with quotes: verified / total (≥75% = green)">Qt</SortableHeader>,
    cell: ({ row }) => <RatioCell actual={row.original.quotesActual} total={row.original.quotesTotal} status={row.original.quotes} />,
  },
  {
    id: "accuracy",
    accessorKey: "accuracyActual",
    header: ({ column }) => <SortableHeader column={column} title="Accuracy verified: checked / total (≥75% = green)">Acc</SortableHeader>,
    cell: ({ row }) => <RatioCell actual={row.original.accuracyActual} total={row.original.accuracyTotal} status={row.original.accuracy} />,
  },
];

// ---------------------------------------------------------------------------
// Presets — named column selections
// ---------------------------------------------------------------------------

/** All column IDs for reference */
const ALL_COLUMN_IDS = columns.map((c) => ("id" in c && c.id) || ("accessorKey" in c && String(c.accessorKey)) || "").filter(Boolean);

interface Preset {
  label: string;
  description: string;
  columns: string[];
}

const PRESETS: Record<string, Preset> = {
  overview: {
    label: "Overview",
    description: "Key quality, risk, and status metrics",
    columns: ["title", "quality", "readerImportance", "score", "riskLevel", "lastUpdated", "wordCount", "entityType", "category"],
  },
  coverage: {
    label: "Coverage",
    description: "Structural completeness targets",
    columns: ["title", "score", "wordCount", "booleans", "tables", "diagrams", "internalLinks", "externalLinks", "footnotes", "references", "quotes", "accuracy"],
  },
  quality: {
    label: "Quality",
    description: "Quality ratings and importance scores",
    columns: ["title", "quality", "readerImportance", "researchImportance", "tacticalValue", "novelty", "rigor", "actionability", "completeness", "wordCount"],
  },
  citations: {
    label: "Citations",
    description: "Citation health and accuracy",
    columns: ["title", "citationTotal", "citationWithQuotes", "citationAccuracyChecked", "citationAvgScore", "quotes", "accuracy", "quality", "wordCount"],
  },
  updates: {
    label: "Updates",
    description: "Freshness and update scheduling",
    columns: ["title", "lastUpdated", "updateFrequency", "quality", "readerImportance", "riskLevel", "wordCount", "category"],
  },
  all: {
    label: "All",
    description: "Every available column",
    columns: ALL_COLUMN_IDS,
  },
};

function presetToVisibility(presetColumns: string[]): VisibilityState {
  const vis: VisibilityState = {};
  for (const id of ALL_COLUMN_IDS) {
    vis[id] = presetColumns.includes(id);
  }
  return vis;
}

// ---------------------------------------------------------------------------
// Table component
// ---------------------------------------------------------------------------

export function CoverageTable({ data }: { data: PageCoverageItem[] }) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: "quality", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    presetToVisibility(PRESETS.overview.columns)
  );
  const [activePreset, setActivePreset] = useState<string>("overview");
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  const applyPreset = useCallback((key: string) => {
    const preset = PRESETS[key];
    if (!preset) return;
    setColumnVisibility(presetToVisibility(preset.columns));
    setActivePreset(key);
  }, []);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: (updater) => {
      setColumnVisibility(updater);
      setActivePreset(""); // custom selection — no preset active
    },
    globalFilterFn: "includesString",
    state: { sorting, globalFilter, columnVisibility },
  });

  const filtered = table.getFilteredRowModel().rows.length;

  return (
    <div className="space-y-3">
      {/* Preset buttons */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {Object.entries(PRESETS).map(([key, preset]) => (
          <button
            key={key}
            onClick={() => applyPreset(key)}
            title={preset.description}
            className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
              activePreset === key
                ? "bg-foreground text-background border-foreground"
                : "bg-background text-muted-foreground border-border hover:bg-muted"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>

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

        <div className="relative">
          <button
            onClick={() => setShowColumnPicker((v) => !v)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-border rounded-md bg-background text-muted-foreground hover:bg-muted transition-colors"
          >
            <Columns3 className="h-3.5 w-3.5" />
            Columns
          </button>
          {showColumnPicker && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-2 min-w-[240px] max-h-[60vh] overflow-y-auto">
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
          {filtered === data.length ? `${data.length} pages` : `${filtered} of ${data.length} pages`}
        </span>
      </div>

      <DataTable table={table} />
    </div>
  );
}
