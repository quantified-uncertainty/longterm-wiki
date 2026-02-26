"use client";

import { useState, useCallback, useMemo } from "react";
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
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search, Columns3, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SortableHeader } from "@/components/ui/sortable-header";

// ---------------------------------------------------------------------------
// Unified row type — merges entity metadata + page coverage + importance
// ---------------------------------------------------------------------------

export interface UnifiedEntityRow {
  // Entity core
  id: string;
  numericId: string | null;
  entityType: string;
  title: string;
  description: string | null;
  status: string | null;
  tags: string[];
  relatedCount: number;
  hasPage: boolean;
  href: string;
  // Importance / rankings
  quality: number | null;
  readerImportance: number | null;
  readerRank: number | null;
  researchImportance: number | null;
  researchRank: number | null;
  tacticalValue: number | null;
  // Page classification
  contentFormat: string | null;
  wordCount: number | null;
  category: string | null;
  subcategory: string | null;
  lastUpdated: string | null;
  updateFrequency: number | null;
  // Coverage
  coverageScore: number | null;
  coverageTotal: number | null;
  // Hallucination risk
  riskLevel: "low" | "medium" | "high" | null;
  riskScore: number | null;
  // Ratings (1-10)
  novelty: number | null;
  rigor: number | null;
  actionability: number | null;
  completeness: number | null;
  // Citation health
  citationTotal: number | null;
  citationWithQuotes: number | null;
  citationAccuracyChecked: number | null;
  citationAvgScore: number | null;
  // Structural
  backlinkCount: number | null;
  sectionCount: number | null;
  unconvertedLinkCount: number | null;
  // Boolean items
  llmSummary: boolean | null;
  schedule: boolean | null;
  entity: boolean | null;
  editHistory: boolean | null;
  // Numeric coverage items (actual/target)
  tablesActual: number | null;
  tablesTarget: number | null;
  tables: "green" | "amber" | "red" | null;
  diagramsActual: number | null;
  diagramsTarget: number | null;
  diagrams: "green" | "amber" | "red" | null;
  internalLinksActual: number | null;
  internalLinksTarget: number | null;
  internalLinks: "green" | "amber" | "red" | null;
  externalLinksActual: number | null;
  externalLinksTarget: number | null;
  externalLinks: "green" | "amber" | "red" | null;
  footnotesActual: number | null;
  footnotesTarget: number | null;
  footnotes: "green" | "amber" | "red" | null;
  referencesActual: number | null;
  referencesTarget: number | null;
  references: "green" | "amber" | "red" | null;
  quotesActual: number | null;
  quotesTotal: number | null;
  quotes: "green" | "amber" | "red" | null;
  accuracyActual: number | null;
  accuracyTotal: number | null;
  accuracy: "green" | "amber" | "red" | null;
}

// ---------------------------------------------------------------------------
// Cell renderers
// ---------------------------------------------------------------------------

type Status = "green" | "amber" | "red";

const TYPE_COLORS: Record<string, string> = {
  risk: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  person: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  organization: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  approach: "bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300",
  concept: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  model: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  policy: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300",
  event: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  capability: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
  metric: "bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300",
};
const DEFAULT_TYPE_COLOR = "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";

const statusColor: Record<Status, string> = {
  green: "text-emerald-600",
  amber: "text-amber-600",
  red: "text-red-400/80",
};

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

const readerThresholds: [number, string][] = [
  [90, "text-purple-500"],
  [70, "text-violet-500"],
  [50, "text-indigo-500"],
  [30, "text-slate-400"],
  [0, "text-slate-400/60"],
];

const researchThresholds: [number, string][] = [
  [90, "text-orange-500"],
  [70, "text-amber-500"],
  [50, "text-yellow-600"],
  [30, "text-slate-400"],
  [0, "text-slate-400/60"],
];

function Dash() {
  return <span className="text-muted-foreground/30 text-xs">-</span>;
}

function NumericCell({
  value,
  thresholds,
}: {
  value: number | null;
  thresholds: [number, string][];
}) {
  if (value == null) return <Dash />;
  const color = thresholds.find(([t]) => value >= t)?.[1] ?? "text-muted-foreground";
  return (
    <span className={`text-xs tabular-nums font-medium ${color}`}>
      {Math.round(value)}
    </span>
  );
}

function RankWithScore({
  rank,
  score,
  thresholds,
}: {
  rank: number | null;
  score: number | null;
  thresholds: [number, string][];
}) {
  if (rank == null || score == null) return <Dash />;
  const color = thresholds.find(([t]) => score >= t)?.[1] ?? "text-muted-foreground";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-xs tabular-nums font-semibold text-foreground">
        #{rank}
      </span>
      <span className={`text-[11px] tabular-nums ${color}`}>
        ({Math.round(score)})
      </span>
    </span>
  );
}

function MetricCell({
  actual,
  target,
  status,
}: {
  actual: number | null;
  target: number | null;
  status: Status | null;
}) {
  if (actual == null || target == null || status == null) return <Dash />;
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
  actual: number | null;
  total: number | null;
  status: Status | null;
}) {
  if (actual == null || total == null || total === 0 || status == null) return <Dash />;
  return (
    <span className={`text-xs tabular-nums font-medium ${statusColor[status]}`}>
      {actual}
      <span className="text-muted-foreground/40">/{total}</span>
    </span>
  );
}

function BoolIcon({ value, label }: { value: boolean | null; label: string }) {
  if (value == null) return <Dash />;
  return value ? (
    <span className="text-emerald-500 text-xs font-bold" title={label}>&#x2713;</span>
  ) : (
    <span className="text-muted-foreground/30 text-xs" title={label}>&#x2717;</span>
  );
}

function ScoreBadge({ score, total }: { score: number | null; total: number | null }) {
  if (score == null || total == null) return <Dash />;
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

function RiskBadge({ level }: { level: "low" | "medium" | "high" | null }) {
  if (!level) return <Dash />;
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
  if (!date) return <Dash />;
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
// Column definitions — ALL columns from all three pages
// ---------------------------------------------------------------------------

const COLUMN_LABELS: Record<string, string> = {
  // Entity core
  id: "Entity ID",
  numericId: "Numeric ID",
  entityType: "Type",
  title: "Title",
  description: "Description",
  status: "Status",
  tags: "Tags",
  relatedCount: "Related Entities",
  hasPage: "Has Page",
  // Importance / rankings
  quality: "Quality",
  readerRank: "Readership Rank",
  researchRank: "Research Rank",
  readerImportance: "Reader Importance",
  researchImportance: "Research Importance",
  tacticalValue: "Tactical Value",
  // Page classification
  contentFormat: "Content Format",
  wordCount: "Word Count",
  category: "Category",
  subcategory: "Subcategory",
  lastUpdated: "Last Updated",
  updateFrequency: "Update Freq (days)",
  // Coverage
  coverageScore: "Coverage Score",
  // Risk
  riskLevel: "Hallucination Risk",
  riskScore: "Risk Score",
  // Ratings
  novelty: "Novelty",
  rigor: "Rigor",
  actionability: "Actionability",
  completeness: "Completeness",
  // Citations
  citationTotal: "Citations Total",
  citationWithQuotes: "Citations w/ Quotes",
  citationAccuracyChecked: "Citations Checked",
  citationAvgScore: "Avg Accuracy Score",
  // Structural
  backlinkCount: "Backlinks",
  sectionCount: "Sections",
  unconvertedLinkCount: "Unconverted Links",
  // Boolean
  booleans: "Bool (Summary, Schedule, Entity, History)",
  // Coverage metrics
  tablesCov: "Tables",
  diagramsCov: "Diagrams",
  internalLinksCov: "Internal Links",
  externalLinksCov: "External Links",
  footnotesCov: "Footnotes",
  referencesCov: "References",
  quotesCov: "Quotes Verified",
  accuracyCov: "Accuracy Verified",
};

const columns: ColumnDef<UnifiedEntityRow>[] = [
  // --- Entity Core ---
  {
    accessorKey: "title",
    header: ({ column }) => <SortableHeader column={column} title="Entity / page title">Title</SortableHeader>,
    cell: ({ row }) => (
      <Link
        href={row.original.href}
        className="text-sm font-medium text-accent-foreground hover:underline no-underline max-w-[220px] truncate block"
      >
        {row.original.title}
      </Link>
    ),
    filterFn: "includesString",
    size: 220,
  },
  {
    accessorKey: "id",
    header: ({ column }) => <SortableHeader column={column} title="Entity slug ID">ID</SortableHeader>,
    cell: ({ row }) => (
      <Link
        href={row.original.href}
        className="text-primary hover:underline text-xs font-mono font-medium"
      >
        {row.original.id}
      </Link>
    ),
    filterFn: "includesString",
  },
  {
    accessorKey: "numericId",
    header: ({ column }) => <SortableHeader column={column} title="Numeric entity ID (e.g. E42)">EID</SortableHeader>,
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.original.numericId || "-"}
      </span>
    ),
    sortUndefined: "last",
  },
  {
    accessorKey: "entityType",
    header: ({ column }) => <SortableHeader column={column} title="Entity type">Type</SortableHeader>,
    cell: ({ row }) => {
      const t = row.original.entityType;
      const color = TYPE_COLORS[t] || DEFAULT_TYPE_COLOR;
      return (
        <span className={`text-xs px-1.5 py-0.5 rounded ${color}`}>
          {t}
        </span>
      );
    },
    filterFn: "includesString",
  },
  {
    accessorKey: "status",
    header: ({ column }) => <SortableHeader column={column} title="Entity status">Status</SortableHeader>,
    cell: ({ row }) => {
      const s = row.original.status;
      if (!s) return <Dash />;
      return <span className="text-xs text-muted-foreground">{s}</span>;
    },
    sortUndefined: "last",
  },
  {
    accessorKey: "tags",
    header: "Tags",
    cell: ({ row }) => {
      const tags = row.original.tags;
      if (!tags.length) return <Dash />;
      const display = tags.slice(0, 3);
      const remaining = tags.length - display.length;
      return (
        <span className="flex flex-wrap gap-0.5 max-w-[200px]">
          {display.map((tag) => (
            <span key={tag} className="text-[10px] px-1 py-px bg-muted rounded text-muted-foreground">
              {tag}
            </span>
          ))}
          {remaining > 0 && (
            <span className="text-[10px] text-muted-foreground/60">+{remaining}</span>
          )}
        </span>
      );
    },
    filterFn: (row, _columnId, filterValue: string) => {
      return row.original.tags.some((tag) =>
        tag.toLowerCase().includes(filterValue.toLowerCase())
      );
    },
  },
  {
    accessorKey: "relatedCount",
    header: ({ column }) => <SortableHeader column={column} title="Number of related entities">Rel</SortableHeader>,
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.original.relatedCount}
      </span>
    ),
  },
  {
    id: "hasPage",
    accessorFn: (row) => (row.hasPage ? "yes" : "no"),
    header: ({ column }) => <SortableHeader column={column} title="Whether this entity has a wiki page">Page</SortableHeader>,
    cell: ({ row }) => {
      if (row.original.hasPage) {
        return (
          <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded dark:bg-green-900 dark:text-green-300">
            yes
          </span>
        );
      }
      return (
        <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded dark:bg-gray-800 dark:text-gray-400">
          no
        </span>
      );
    },
  },
  {
    accessorKey: "description",
    header: "Description",
    cell: ({ row }) => (
      <span
        className="text-xs text-muted-foreground max-w-[250px] truncate block"
        title={row.original.description ?? undefined}
      >
        {row.original.description || "-"}
      </span>
    ),
  },

  // --- Quality & Importance ---
  {
    accessorKey: "quality",
    header: ({ column }) => <SortableHeader column={column} title="Quality score (0-100)">Qual</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.quality} thresholds={scoreThresholds} />,
    sortUndefined: "last",
  },
  {
    accessorKey: "readerRank",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Readership importance rank and score">Readership</SortableHeader>,
    cell: ({ row }) => (
      <RankWithScore
        rank={row.original.readerRank}
        score={row.original.readerImportance}
        thresholds={readerThresholds}
      />
    ),
  },
  {
    accessorKey: "researchRank",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Research importance rank and score">Research</SortableHeader>,
    cell: ({ row }) => (
      <RankWithScore
        rank={row.original.researchRank}
        score={row.original.researchImportance}
        thresholds={researchThresholds}
      />
    ),
  },
  {
    accessorKey: "readerImportance",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Reader importance (0-100)">Imp</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.readerImportance} thresholds={scoreThresholds} />,
  },
  {
    accessorKey: "researchImportance",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Research importance (0-100)">Res</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.researchImportance} thresholds={scoreThresholds} />,
  },
  {
    accessorKey: "tacticalValue",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Tactical / shareability value (0-100)">Tact</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.tacticalValue} thresholds={scoreThresholds} />,
  },

  // --- Coverage ---
  {
    id: "coverageScore",
    accessorKey: "coverageScore",
    header: ({ column }) => <SortableHeader column={column} title="Coverage: passing items out of 13">Cov</SortableHeader>,
    cell: ({ row }) => <ScoreBadge score={row.original.coverageScore} total={row.original.coverageTotal} />,
    sortUndefined: "last",
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
    header: ({ column }) => <SortableHeader column={column} title="Hallucination risk score (0-100, higher = riskier)">RiskN</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.riskScore;
      if (v == null) return <Dash />;
      const color = v >= 70 ? "text-red-500" : v >= 40 ? "text-amber-500" : "text-emerald-500";
      return <span className={`text-xs tabular-nums font-medium ${color}`}>{Math.round(v)}</span>;
    },
  },

  // --- Temporal ---
  {
    accessorKey: "lastUpdated",
    header: ({ column }) => <SortableHeader column={column} title="Time since last update">Updated</SortableHeader>,
    cell: ({ row }) => <DateCell date={row.original.lastUpdated} />,
    sortUndefined: "last",
  },
  {
    accessorKey: "updateFrequency",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Target update frequency in days">Freq</SortableHeader>,
    cell: ({ row }) => {
      const f = row.original.updateFrequency;
      if (f == null) return <Dash />;
      return <span className="text-xs tabular-nums text-muted-foreground">{f}d</span>;
    },
  },

  // --- Classification ---
  {
    accessorKey: "contentFormat",
    header: ({ column }) => <SortableHeader column={column} title="Content format">Fmt</SortableHeader>,
    cell: ({ row }) => {
      const f = row.original.contentFormat;
      return f ? <span className="text-xs text-muted-foreground">{f}</span> : <Dash />;
    },
    sortUndefined: "last",
  },
  {
    accessorKey: "wordCount",
    header: ({ column }) => <SortableHeader column={column} title="Word count">Words</SortableHeader>,
    cell: ({ row }) => {
      const wc = row.original.wordCount;
      if (wc == null) return <Dash />;
      return <span className="text-xs tabular-nums text-muted-foreground">{wc >= 1000 ? `${(wc / 1000).toFixed(1)}k` : wc}</span>;
    },
    sortUndefined: "last",
  },
  {
    accessorKey: "category",
    header: ({ column }) => <SortableHeader column={column} title="Page category">Cat</SortableHeader>,
    cell: ({ row }) => {
      const c = row.original.category;
      return c ? <span className="text-xs text-muted-foreground">{c}</span> : <Dash />;
    },
    sortUndefined: "last",
  },
  {
    accessorKey: "subcategory",
    header: ({ column }) => <SortableHeader column={column} title="Page subcategory">Sub</SortableHeader>,
    cell: ({ row }) => {
      const s = row.original.subcategory;
      return s ? <span className="text-xs text-muted-foreground">{s}</span> : <Dash />;
    },
    sortUndefined: "last",
  },

  // --- Ratings (1-10) ---
  {
    accessorKey: "novelty",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Novelty rating (1-10)">Nov</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.novelty} thresholds={ratingThresholds} />,
  },
  {
    accessorKey: "rigor",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Rigor rating (1-10)">Rig</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.rigor} thresholds={ratingThresholds} />,
  },
  {
    accessorKey: "actionability",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Actionability rating (1-10)">Act</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.actionability} thresholds={ratingThresholds} />,
  },
  {
    accessorKey: "completeness",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Completeness rating (1-10)">Comp</SortableHeader>,
    cell: ({ row }) => <NumericCell value={row.original.completeness} thresholds={ratingThresholds} />,
  },

  // --- Citation health ---
  {
    accessorKey: "citationTotal",
    header: ({ column }) => <SortableHeader column={column} title="Total citations on this page">Cit</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.citationTotal;
      if (v == null) return <Dash />;
      return v > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{v}</span> : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
    sortUndefined: "last",
  },
  {
    accessorKey: "citationWithQuotes",
    header: ({ column }) => <SortableHeader column={column} title="Citations with supporting quotes">CitQ</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.citationWithQuotes;
      if (v == null) return <Dash />;
      return v > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{v}</span> : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
    sortUndefined: "last",
  },
  {
    accessorKey: "citationAccuracyChecked",
    header: ({ column }) => <SortableHeader column={column} title="Citations with accuracy verification">CitA</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.citationAccuracyChecked;
      if (v == null) return <Dash />;
      return v > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{v}</span> : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
    sortUndefined: "last",
  },
  {
    accessorKey: "citationAvgScore",
    sortUndefined: "last",
    header: ({ column }) => <SortableHeader column={column} title="Average citation accuracy score">AvgA</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.citationAvgScore;
      if (v == null) return <Dash />;
      const color = v >= 0.8 ? "text-emerald-500" : v >= 0.5 ? "text-amber-500" : "text-red-400";
      return <span className={`text-xs tabular-nums font-medium ${color}`}>{(v * 100).toFixed(0)}%</span>;
    },
  },

  // --- Structural ---
  {
    accessorKey: "backlinkCount",
    header: ({ column }) => <SortableHeader column={column} title="Pages linking to this page">BL</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.backlinkCount;
      if (v == null) return <Dash />;
      return <span className="text-xs tabular-nums text-muted-foreground">{v}</span>;
    },
    sortUndefined: "last",
  },
  {
    accessorKey: "sectionCount",
    header: ({ column }) => <SortableHeader column={column} title="Number of sections">Sec</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.sectionCount;
      if (v == null) return <Dash />;
      return <span className="text-xs tabular-nums text-muted-foreground">{v}</span>;
    },
    sortUndefined: "last",
  },
  {
    accessorKey: "unconvertedLinkCount",
    header: ({ column }) => <SortableHeader column={column} title="Markdown links that should be EntityLinks">Unconv</SortableHeader>,
    cell: ({ row }) => {
      const v = row.original.unconvertedLinkCount;
      if (v == null) return <Dash />;
      return v > 0
        ? <span className="text-xs tabular-nums text-amber-500">{v}</span>
        : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
    sortUndefined: "last",
  },

  // --- Boolean items ---
  {
    id: "booleans",
    header: () => (
      <span className="text-xs font-medium cursor-help" title="Boolean checks: LLM Summary, Update Schedule, Entity, Edit History">
        Bool
      </span>
    ),
    cell: ({ row }) => {
      if (row.original.llmSummary == null) return <Dash />;
      return (
        <span className="inline-flex items-center gap-1">
          <BoolIcon value={row.original.llmSummary} label="LLM Summary" />
          <BoolIcon value={row.original.schedule} label="Update Schedule" />
          <BoolIcon value={row.original.entity} label="Entity" />
          <BoolIcon value={row.original.editHistory} label="Edit History" />
        </span>
      );
    },
  },

  // --- Coverage metrics (actual/target) ---
  {
    id: "tablesCov",
    accessorFn: (row) => row.tablesActual,
    header: ({ column }) => <SortableHeader column={column} title="Tables: actual / target">Tbl</SortableHeader>,
    cell: ({ row }) => <MetricCell actual={row.original.tablesActual} target={row.original.tablesTarget} status={row.original.tables} />,
    sortUndefined: "last",
  },
  {
    id: "diagramsCov",
    accessorFn: (row) => row.diagramsActual,
    header: ({ column }) => <SortableHeader column={column} title="Diagrams: actual / target">Dia</SortableHeader>,
    cell: ({ row }) => <MetricCell actual={row.original.diagramsActual} target={row.original.diagramsTarget} status={row.original.diagrams} />,
    sortUndefined: "last",
  },
  {
    id: "internalLinksCov",
    accessorFn: (row) => row.internalLinksActual,
    header: ({ column }) => <SortableHeader column={column} title="Internal links: actual / target">Int</SortableHeader>,
    cell: ({ row }) => <MetricCell actual={row.original.internalLinksActual} target={row.original.internalLinksTarget} status={row.original.internalLinks} />,
    sortUndefined: "last",
  },
  {
    id: "externalLinksCov",
    accessorFn: (row) => row.externalLinksActual,
    header: ({ column }) => <SortableHeader column={column} title="External links: actual / target">Ext</SortableHeader>,
    cell: ({ row }) => <MetricCell actual={row.original.externalLinksActual} target={row.original.externalLinksTarget} status={row.original.externalLinks} />,
    sortUndefined: "last",
  },
  {
    id: "footnotesCov",
    accessorFn: (row) => row.footnotesActual,
    header: ({ column }) => <SortableHeader column={column} title="Footnotes: actual / target">Fn</SortableHeader>,
    cell: ({ row }) => <MetricCell actual={row.original.footnotesActual} target={row.original.footnotesTarget} status={row.original.footnotes} />,
    sortUndefined: "last",
  },
  {
    id: "referencesCov",
    accessorFn: (row) => row.referencesActual,
    header: ({ column }) => <SortableHeader column={column} title="Resource references: actual / target">Ref</SortableHeader>,
    cell: ({ row }) => <MetricCell actual={row.original.referencesActual} target={row.original.referencesTarget} status={row.original.references} />,
    sortUndefined: "last",
  },
  {
    id: "quotesCov",
    accessorFn: (row) => row.quotesActual,
    header: ({ column }) => <SortableHeader column={column} title="Citations with quotes: verified / total">Qt</SortableHeader>,
    cell: ({ row }) => <RatioCell actual={row.original.quotesActual} total={row.original.quotesTotal} status={row.original.quotes} />,
    sortUndefined: "last",
  },
  {
    id: "accuracyCov",
    accessorFn: (row) => row.accuracyActual,
    header: ({ column }) => <SortableHeader column={column} title="Accuracy verified: checked / total">Acc</SortableHeader>,
    cell: ({ row }) => <RatioCell actual={row.original.accuracyActual} total={row.original.accuracyTotal} status={row.original.accuracy} />,
    sortUndefined: "last",
  },
];

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const ALL_COLUMN_IDS = columns.map((c) =>
  ("id" in c && c.id) || ("accessorKey" in c && String(c.accessorKey)) || ""
).filter(Boolean);

interface Preset {
  label: string;
  description: string;
  columns: string[];
  defaultSort: SortingState;
}

const PRESETS: Record<string, Preset> = {
  overview: {
    label: "Overview",
    description: "Key quality, risk, and status metrics for pages with content",
    columns: ["title", "entityType", "quality", "readerImportance", "coverageScore", "riskLevel", "lastUpdated", "wordCount", "category"],
    defaultSort: [{ id: "quality", desc: true }],
  },
  entities: {
    label: "Entities",
    description: "All entities with metadata (ID, type, status, tags, related count)",
    columns: ["title", "id", "numericId", "entityType", "status", "tags", "relatedCount", "hasPage", "lastUpdated"],
    defaultSort: [{ id: "title", desc: false }],
  },
  importance: {
    label: "Importance",
    description: "Readership and research importance rankings with scores",
    columns: ["title", "readerRank", "researchRank", "quality", "tacticalValue", "category", "wordCount"],
    defaultSort: [{ id: "readerRank", desc: false }],
  },
  quality: {
    label: "Quality",
    description: "Quality ratings and content assessment",
    columns: ["title", "quality", "readerImportance", "researchImportance", "tacticalValue", "novelty", "rigor", "actionability", "completeness", "wordCount"],
    defaultSort: [{ id: "quality", desc: true }],
  },
  coverage: {
    label: "Coverage",
    description: "Structural completeness targets and metrics",
    columns: ["title", "coverageScore", "wordCount", "booleans", "tablesCov", "diagramsCov", "internalLinksCov", "externalLinksCov", "footnotesCov", "referencesCov", "quotesCov", "accuracyCov"],
    defaultSort: [{ id: "coverageScore", desc: false }],
  },
  citations: {
    label: "Citations",
    description: "Citation health and accuracy metrics",
    columns: ["title", "citationTotal", "citationWithQuotes", "citationAccuracyChecked", "citationAvgScore", "quotesCov", "accuracyCov", "quality", "wordCount"],
    defaultSort: [{ id: "citationTotal", desc: true }],
  },
  updates: {
    label: "Updates",
    description: "Freshness and update scheduling",
    columns: ["title", "lastUpdated", "updateFrequency", "quality", "readerImportance", "riskLevel", "wordCount", "category"],
    defaultSort: [{ id: "lastUpdated", desc: false }],
  },
  all: {
    label: "All",
    description: "Every available column",
    columns: ALL_COLUMN_IDS,
    defaultSort: [{ id: "title", desc: false }],
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
// Main table component
// ---------------------------------------------------------------------------

export function EntitiesDataTable({ entities }: { entities: UnifiedEntityRow[] }) {
  const [sorting, setSorting] = useState<SortingState>(PRESETS.overview.defaultSort);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    presetToVisibility(PRESETS.overview.columns)
  );
  const [activePreset, setActivePreset] = useState<string>("overview");
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [pageFilter, setPageFilter] = useState<string>("");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entities) {
      counts.set(e.entityType, (counts.get(e.entityType) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [entities]);

  const filteredData = useMemo(() => {
    let data = entities;
    if (typeFilter) {
      data = data.filter((e) => e.entityType === typeFilter);
    }
    if (pageFilter === "with") {
      data = data.filter((e) => e.hasPage);
    } else if (pageFilter === "without") {
      data = data.filter((e) => !e.hasPage);
    }
    return data;
  }, [entities, typeFilter, pageFilter]);

  const applyPreset = useCallback((key: string) => {
    const preset = PRESETS[key];
    if (!preset) return;
    setColumnVisibility(presetToVisibility(preset.columns));
    setSorting(preset.defaultSort);
    setActivePreset(key);
  }, []);

  const table = useReactTable({
    data: filteredData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    onColumnVisibilityChange: (updater) => {
      setColumnVisibility(updater);
      setActivePreset("");
    },
    globalFilterFn: "includesString",
    state: { sorting, globalFilter, columnVisibility, pagination },
  });

  const filtered = table.getFilteredRowModel().rows.length;
  const total = entities.length;

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
            placeholder="Search entities..."
            value={globalFilter ?? ""}
            onChange={(e) => {
              setGlobalFilter(e.target.value);
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            className="h-9 w-full rounded-lg border border-border bg-background pl-10 pr-4 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>

        {/* Type filter */}
        <select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setPagination((p) => ({ ...p, pageIndex: 0 }));
          }}
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm shadow-sm"
        >
          <option value="">All types</option>
          {types.map(([type, count]) => (
            <option key={type} value={type}>
              {type} ({count})
            </option>
          ))}
        </select>

        {/* Page filter */}
        <select
          value={pageFilter}
          onChange={(e) => {
            setPageFilter(e.target.value);
            setPagination((p) => ({ ...p, pageIndex: 0 }));
          }}
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm shadow-sm"
        >
          <option value="">All entities</option>
          <option value="with">With page</option>
          <option value="without">Without page</option>
        </select>

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
                  {COLUMN_LABELS[col.id] ?? col.id.charAt(0).toUpperCase() + col.id.slice(1).replace(/([A-Z])/g, " $1")}
                </label>
              ))}
            </div>
          )}
        </div>

        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filtered === total ? `${total} entities` : `${filtered} of ${total} entities`}
        </span>
      </div>

      <DataTable table={table} stickyFirstColumn />

      {/* Pagination */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Rows per page:</span>
          <select
            value={pagination.pageSize}
            onChange={(e) => setPagination({ pageIndex: 0, pageSize: Number(e.target.value) })}
            className="h-7 rounded border border-border bg-background px-2 text-xs"
          >
            {[25, 50, 100, 200].map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            Page {pagination.pageIndex + 1} of {table.getPageCount() || 1}
          </span>
          <button
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
            className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronsLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
            disabled={!table.getCanNextPage()}
            className="p-1 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
