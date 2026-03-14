"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  ServerPaginatedTable,
  type ColumnDef,
  type SortDir,
} from "@/components/server-paginated-table";

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
// Column definitions — ALL columns using SPT ColumnDef format
// ---------------------------------------------------------------------------

const ALL_COLUMNS: ColumnDef<UnifiedEntityRow>[] = [
  // --- Entity Core ---
  {
    id: "title",
    header: "Title",
    sortField: "title",
    accessor: (row) => (
      <Link
        href={row.href}
        className="text-sm font-medium text-accent-foreground hover:underline no-underline max-w-[220px] truncate block"
      >
        {row.title}
      </Link>
    ),
  },
  {
    id: "id",
    header: "ID",
    sortField: "id",
    accessor: (row) => (
      <Link
        href={row.href}
        className="text-primary hover:underline text-xs font-mono font-medium"
      >
        {row.id}
      </Link>
    ),
  },
  {
    id: "numericId",
    header: "EID",
    sortField: "numericId",
    accessor: (row) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.numericId || "-"}
      </span>
    ),
  },
  {
    id: "entityType",
    header: "Type",
    sortField: "entityType",
    accessor: (row) => {
      const color = TYPE_COLORS[row.entityType] || DEFAULT_TYPE_COLOR;
      return (
        <span className={`text-xs px-1.5 py-0.5 rounded ${color}`}>
          {row.entityType}
        </span>
      );
    },
  },
  {
    id: "status",
    header: "Status",
    sortField: "status",
    accessor: (row) => {
      if (!row.status) return <Dash />;
      return <span className="text-xs text-muted-foreground">{row.status}</span>;
    },
  },
  {
    id: "tags",
    header: "Tags",
    accessor: (row) => {
      if (!row.tags.length) return <Dash />;
      const display = row.tags.slice(0, 3);
      const remaining = row.tags.length - display.length;
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
  },
  {
    id: "relatedCount",
    header: "Rel",
    sortField: "relatedCount",
    accessor: (row) => (
      <span className="text-xs tabular-nums text-muted-foreground">
        {row.relatedCount}
      </span>
    ),
  },
  {
    id: "hasPage",
    header: "Page",
    sortField: "hasPage",
    accessor: (row) => {
      if (row.hasPage) {
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
    id: "description",
    header: "Description",
    accessor: (row) => (
      <span
        className="text-xs text-muted-foreground max-w-[250px] truncate block"
        title={row.description ?? undefined}
      >
        {row.description || "-"}
      </span>
    ),
  },

  // --- Quality & Importance ---
  {
    id: "quality",
    header: "Qual",
    sortField: "quality",
    accessor: (row) => <NumericCell value={row.quality} thresholds={scoreThresholds} />,
  },
  {
    id: "readerRank",
    header: "Readership",
    sortField: "readerRank",
    accessor: (row) => (
      <RankWithScore
        rank={row.readerRank}
        score={row.readerImportance}
        thresholds={readerThresholds}
      />
    ),
  },
  {
    id: "researchRank",
    header: "Research",
    sortField: "researchRank",
    accessor: (row) => (
      <RankWithScore
        rank={row.researchRank}
        score={row.researchImportance}
        thresholds={researchThresholds}
      />
    ),
  },
  {
    id: "readerImportance",
    header: "Imp",
    sortField: "readerImportance",
    accessor: (row) => <NumericCell value={row.readerImportance} thresholds={scoreThresholds} />,
  },
  {
    id: "researchImportance",
    header: "Res",
    sortField: "researchImportance",
    accessor: (row) => <NumericCell value={row.researchImportance} thresholds={scoreThresholds} />,
  },
  {
    id: "tacticalValue",
    header: "Tact",
    sortField: "tacticalValue",
    accessor: (row) => <NumericCell value={row.tacticalValue} thresholds={scoreThresholds} />,
  },

  // --- Coverage ---
  {
    id: "coverageScore",
    header: "Cov",
    sortField: "coverageScore",
    accessor: (row) => <ScoreBadge score={row.coverageScore} total={row.coverageTotal} />,
  },

  // --- Risk ---
  {
    id: "riskLevel",
    header: "Risk",
    sortField: "riskLevel",
    accessor: (row) => <RiskBadge level={row.riskLevel} />,
  },
  {
    id: "riskScore",
    header: "RiskN",
    sortField: "riskScore",
    accessor: (row) => {
      const v = row.riskScore;
      if (v == null) return <Dash />;
      const color = v >= 70 ? "text-red-500" : v >= 40 ? "text-amber-500" : "text-emerald-500";
      return <span className={`text-xs tabular-nums font-medium ${color}`}>{Math.round(v)}</span>;
    },
  },

  // --- Temporal ---
  {
    id: "lastUpdated",
    header: "Updated",
    sortField: "lastUpdated",
    accessor: (row) => <DateCell date={row.lastUpdated} />,
  },
  {
    id: "updateFrequency",
    header: "Freq",
    sortField: "updateFrequency",
    accessor: (row) => {
      const f = row.updateFrequency;
      if (f == null) return <Dash />;
      return <span className="text-xs tabular-nums text-muted-foreground">{f}d</span>;
    },
  },

  // --- Classification ---
  {
    id: "contentFormat",
    header: "Fmt",
    sortField: "contentFormat",
    accessor: (row) => {
      const f = row.contentFormat;
      return f ? <span className="text-xs text-muted-foreground">{f}</span> : <Dash />;
    },
  },
  {
    id: "wordCount",
    header: "Words",
    sortField: "wordCount",
    accessor: (row) => {
      const wc = row.wordCount;
      if (wc == null) return <Dash />;
      return <span className="text-xs tabular-nums text-muted-foreground">{wc >= 1000 ? `${(wc / 1000).toFixed(1)}k` : wc}</span>;
    },
  },
  {
    id: "category",
    header: "Cat",
    sortField: "category",
    accessor: (row) => {
      const c = row.category;
      return c ? <span className="text-xs text-muted-foreground">{c}</span> : <Dash />;
    },
  },
  {
    id: "subcategory",
    header: "Sub",
    sortField: "subcategory",
    accessor: (row) => {
      const s = row.subcategory;
      return s ? <span className="text-xs text-muted-foreground">{s}</span> : <Dash />;
    },
  },

  // --- Ratings (1-10) ---
  {
    id: "novelty",
    header: "Nov",
    sortField: "novelty",
    accessor: (row) => <NumericCell value={row.novelty} thresholds={ratingThresholds} />,
  },
  {
    id: "rigor",
    header: "Rig",
    sortField: "rigor",
    accessor: (row) => <NumericCell value={row.rigor} thresholds={ratingThresholds} />,
  },
  {
    id: "actionability",
    header: "Act",
    sortField: "actionability",
    accessor: (row) => <NumericCell value={row.actionability} thresholds={ratingThresholds} />,
  },
  {
    id: "completeness",
    header: "Comp",
    sortField: "completeness",
    accessor: (row) => <NumericCell value={row.completeness} thresholds={ratingThresholds} />,
  },

  // --- Citation health ---
  {
    id: "citationTotal",
    header: "Cit",
    sortField: "citationTotal",
    accessor: (row) => {
      const v = row.citationTotal;
      if (v == null) return <Dash />;
      return v > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{v}</span> : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
  },
  {
    id: "citationWithQuotes",
    header: "CitQ",
    sortField: "citationWithQuotes",
    accessor: (row) => {
      const v = row.citationWithQuotes;
      if (v == null) return <Dash />;
      return v > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{v}</span> : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
  },
  {
    id: "citationAccuracyChecked",
    header: "CitA",
    sortField: "citationAccuracyChecked",
    accessor: (row) => {
      const v = row.citationAccuracyChecked;
      if (v == null) return <Dash />;
      return v > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{v}</span> : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
  },
  {
    id: "citationAvgScore",
    header: "AvgA",
    sortField: "citationAvgScore",
    accessor: (row) => {
      const v = row.citationAvgScore;
      if (v == null) return <Dash />;
      const color = v >= 0.8 ? "text-emerald-500" : v >= 0.5 ? "text-amber-500" : "text-red-400";
      return <span className={`text-xs tabular-nums font-medium ${color}`}>{(v * 100).toFixed(0)}%</span>;
    },
  },

  // --- Structural ---
  {
    id: "backlinkCount",
    header: "BL",
    sortField: "backlinkCount",
    accessor: (row) => {
      const v = row.backlinkCount;
      if (v == null) return <Dash />;
      return <span className="text-xs tabular-nums text-muted-foreground">{v}</span>;
    },
  },
  {
    id: "sectionCount",
    header: "Sec",
    sortField: "sectionCount",
    accessor: (row) => {
      const v = row.sectionCount;
      if (v == null) return <Dash />;
      return <span className="text-xs tabular-nums text-muted-foreground">{v}</span>;
    },
  },
  {
    id: "unconvertedLinkCount",
    header: "Unconv",
    sortField: "unconvertedLinkCount",
    accessor: (row) => {
      const v = row.unconvertedLinkCount;
      if (v == null) return <Dash />;
      return v > 0
        ? <span className="text-xs tabular-nums text-amber-500">{v}</span>
        : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
  },

  // --- Boolean items ---
  {
    id: "booleans",
    header: "Bool",
    accessor: (row) => {
      if (row.llmSummary == null) return <Dash />;
      return (
        <span className="inline-flex items-center gap-1">
          <BoolIcon value={row.llmSummary} label="LLM Summary" />
          <BoolIcon value={row.schedule} label="Update Schedule" />
          <BoolIcon value={row.entity} label="Entity" />
          <BoolIcon value={row.editHistory} label="Edit History" />
        </span>
      );
    },
  },

  // --- Coverage metrics (actual/target) ---
  {
    id: "tablesCov",
    header: "Tbl",
    sortField: "tablesActual",
    accessor: (row) => <MetricCell actual={row.tablesActual} target={row.tablesTarget} status={row.tables} />,
  },
  {
    id: "diagramsCov",
    header: "Dia",
    sortField: "diagramsActual",
    accessor: (row) => <MetricCell actual={row.diagramsActual} target={row.diagramsTarget} status={row.diagrams} />,
  },
  {
    id: "internalLinksCov",
    header: "Int",
    sortField: "internalLinksActual",
    accessor: (row) => <MetricCell actual={row.internalLinksActual} target={row.internalLinksTarget} status={row.internalLinks} />,
  },
  {
    id: "externalLinksCov",
    header: "Ext",
    sortField: "externalLinksActual",
    accessor: (row) => <MetricCell actual={row.externalLinksActual} target={row.externalLinksTarget} status={row.externalLinks} />,
  },
  {
    id: "footnotesCov",
    header: "Fn",
    sortField: "footnotesActual",
    accessor: (row) => <MetricCell actual={row.footnotesActual} target={row.footnotesTarget} status={row.footnotes} />,
  },
  {
    id: "referencesCov",
    header: "Ref",
    sortField: "referencesActual",
    accessor: (row) => <MetricCell actual={row.referencesActual} target={row.referencesTarget} status={row.references} />,
  },
  {
    id: "quotesCov",
    header: "Qt",
    sortField: "quotesActual",
    accessor: (row) => <RatioCell actual={row.quotesActual} total={row.quotesTotal} status={row.quotes} />,
  },
  {
    id: "accuracyCov",
    header: "Acc",
    sortField: "accuracyActual",
    accessor: (row) => <RatioCell actual={row.accuracyActual} total={row.accuracyTotal} status={row.accuracy} />,
  },
];

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const ALL_COLUMN_IDS = ALL_COLUMNS.map((c) => c.id);

interface Preset {
  label: string;
  description: string;
  columns: string[];
  defaultSortId: string;
  defaultSortDir: SortDir;
}

const PRESETS: Record<string, Preset> = {
  overview: {
    label: "Overview",
    description: "Key quality, risk, and status metrics for pages with content",
    columns: ["title", "entityType", "quality", "readerImportance", "coverageScore", "riskLevel", "lastUpdated", "wordCount", "category"],
    defaultSortId: "quality",
    defaultSortDir: "desc",
  },
  entities: {
    label: "Entities",
    description: "All entities with metadata (ID, type, status, tags, related count)",
    columns: ["title", "id", "numericId", "entityType", "status", "tags", "relatedCount", "hasPage", "lastUpdated"],
    defaultSortId: "title",
    defaultSortDir: "asc",
  },
  importance: {
    label: "Importance",
    description: "Readership and research importance rankings with scores",
    columns: ["title", "readerRank", "researchRank", "quality", "tacticalValue", "category", "wordCount"],
    defaultSortId: "readerRank",
    defaultSortDir: "asc",
  },
  quality: {
    label: "Quality",
    description: "Quality ratings and content assessment",
    columns: ["title", "quality", "readerImportance", "researchImportance", "tacticalValue", "novelty", "rigor", "actionability", "completeness", "wordCount"],
    defaultSortId: "quality",
    defaultSortDir: "desc",
  },
  coverage: {
    label: "Coverage",
    description: "Structural completeness targets and metrics",
    columns: ["title", "coverageScore", "wordCount", "booleans", "tablesCov", "diagramsCov", "internalLinksCov", "externalLinksCov", "footnotesCov", "referencesCov", "quotesCov", "accuracyCov"],
    defaultSortId: "coverageScore",
    defaultSortDir: "asc",
  },
  citations: {
    label: "Citations",
    description: "Citation health and accuracy metrics",
    columns: ["title", "citationTotal", "citationWithQuotes", "citationAccuracyChecked", "citationAvgScore", "quotesCov", "accuracyCov", "quality", "wordCount"],
    defaultSortId: "citationTotal",
    defaultSortDir: "desc",
  },
  updates: {
    label: "Updates",
    description: "Freshness and update scheduling",
    columns: ["title", "lastUpdated", "updateFrequency", "quality", "readerImportance", "riskLevel", "wordCount", "category"],
    defaultSortId: "lastUpdated",
    defaultSortDir: "asc",
  },
  all: {
    label: "All",
    description: "Every available column",
    columns: ALL_COLUMN_IDS,
    defaultSortId: "title",
    defaultSortDir: "asc",
  },
};

// ---------------------------------------------------------------------------
// Static sort comparator
// ---------------------------------------------------------------------------

const RISK_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function compareNullable(
  a: string | number | boolean | null | undefined,
  b: string | number | boolean | null | undefined,
  dir: SortDir
): number {
  // nulls always last regardless of direction
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const mult = dir === "asc" ? 1 : -1;
  if (typeof a === "boolean" && typeof b === "boolean") {
    return (Number(a) - Number(b)) * mult;
  }
  if (typeof a === "number" && typeof b === "number") {
    return (a - b) * mult;
  }
  return String(a).localeCompare(String(b)) * mult;
}

function staticSort(a: UnifiedEntityRow, b: UnifiedEntityRow, sortId: string, dir: SortDir): number {
  // Special sort for risk level
  if (sortId === "riskLevel") {
    const aVal = RISK_ORDER[a.riskLevel ?? ""] ?? 3;
    const bVal = RISK_ORDER[b.riskLevel ?? ""] ?? 3;
    return dir === "asc" ? aVal - bVal : bVal - aVal;
  }

  const key = sortId as keyof UnifiedEntityRow;
  const aVal = a[key];
  const bVal = b[key];
  return compareNullable(
    aVal as string | number | boolean | null,
    bVal as string | number | boolean | null,
    dir
  );
}

// ---------------------------------------------------------------------------
// Main table component
// ---------------------------------------------------------------------------

export function EntitiesDataTable({ entities }: { entities: UnifiedEntityRow[] }) {
  const [activePreset, setActivePreset] = useState<string>("overview");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [pageFilter, setPageFilter] = useState<string>("");

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

  const preset = PRESETS[activePreset] || PRESETS.overview;

  // Build columns array filtered by the current preset
  const presetColumns = useMemo(() => {
    const presetColIds = new Set(preset.columns);
    return ALL_COLUMNS.map((col) => ({
      ...col,
      defaultVisible: presetColIds.has(col.id),
    }));
  }, [preset]);

  const applyPreset = useCallback((key: string) => {
    setActivePreset(key);
  }, []);

  return (
    <div className="space-y-3">
      {/* Preset buttons */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {Object.entries(PRESETS).map(([key, p]) => (
          <button
            key={key}
            onClick={() => applyPreset(key)}
            title={p.description}
            className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
              activePreset === key
                ? "bg-foreground text-background border-foreground"
                : "bg-background text-muted-foreground border-border hover:bg-muted"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* External filters (type + page) */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm shadow-sm"
        >
          <option value="">All types</option>
          {types.map(([type, count]) => (
            <option key={type} value={type}>
              {type} ({count})
            </option>
          ))}
        </select>

        <select
          value={pageFilter}
          onChange={(e) => setPageFilter(e.target.value)}
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm shadow-sm"
        >
          <option value="">All entities</option>
          <option value="with">With page</option>
          <option value="without">Without page</option>
        </select>
      </div>

      {/* SPT table — key forces re-mount when preset changes to reset column visibility */}
      <ServerPaginatedTable<UnifiedEntityRow>
        key={activePreset}
        columns={presetColumns}
        rows={filteredData}
        searchFields={["title", "id", "entityType", "description"]}
        rowKey={(row) => row.id}
        pageSize={50}
        defaultSortId={preset.defaultSortId}
        defaultSortDir={preset.defaultSortDir}
        searchPlaceholder="Search entities..."
        itemLabel="entities"
        showColumnPicker
        staticSort={staticSort}
        stickyFirstColumn
      />
    </div>
  );
}
