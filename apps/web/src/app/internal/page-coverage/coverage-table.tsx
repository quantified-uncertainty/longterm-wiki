"use client";

import { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  ServerPaginatedTable,
  type ColumnDef,
  type SortDir,
} from "@/components/server-paginated-table";
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
    <span className="text-emerald-500 text-xs font-bold" title={label}>&#x2713;</span>
  ) : (
    <span className="text-muted-foreground/30 text-xs" title={label}>&#x2717;</span>
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
// Column definitions — ALL possible columns using SPT ColumnDef format
// ---------------------------------------------------------------------------

const ALL_COLUMNS: ColumnDef<PageCoverageItem>[] = [
  // --- Core ---
  {
    id: "title",
    header: "Title",
    sortField: "title",
    accessor: (row) => (
      <Link href={`/wiki/${row.numericId}`} className="text-sm font-medium text-accent-foreground hover:underline no-underline max-w-[200px] truncate block">
        {row.title}
      </Link>
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
    id: "score",
    header: "Cov",
    sortField: "score",
    accessor: (row) => <ScoreBadge score={row.score} total={row.total} />,
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
      if (v == null) return <span className="text-muted-foreground/30 text-xs">-</span>;
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
      if (f == null) return <span className="text-muted-foreground/30 text-xs">-</span>;
      return <span className="text-xs tabular-nums text-muted-foreground">{f}d</span>;
    },
  },

  // --- Classification ---
  {
    id: "contentFormat",
    header: "Fmt",
    sortField: "contentFormat",
    accessor: (row) => <span className="text-xs text-muted-foreground">{row.contentFormat}</span>,
  },
  {
    id: "wordCount",
    header: "Words",
    sortField: "wordCount",
    accessor: (row) => {
      const wc = row.wordCount;
      return <span className="text-xs tabular-nums text-muted-foreground">{wc >= 1000 ? `${(wc / 1000).toFixed(1)}k` : wc}</span>;
    },
  },
  {
    id: "entityType",
    header: "Type",
    sortField: "entityType",
    accessor: (row) => {
      const t = row.entityType;
      return t ? <span className="text-xs text-muted-foreground">{t}</span> : <span className="text-muted-foreground/30 text-xs">-</span>;
    },
  },
  {
    id: "category",
    header: "Cat",
    sortField: "category",
    accessor: (row) => <span className="text-xs text-muted-foreground">{row.category}</span>,
  },
  {
    id: "subcategory",
    header: "Sub",
    sortField: "subcategory",
    accessor: (row) => {
      const s = row.subcategory;
      return s ? <span className="text-xs text-muted-foreground">{s}</span> : <span className="text-muted-foreground/30 text-xs">-</span>;
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
      return v > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{v}</span> : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
  },
  {
    id: "citationWithQuotes",
    header: "CitQ",
    sortField: "citationWithQuotes",
    accessor: (row) => {
      const v = row.citationWithQuotes;
      return v > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{v}</span> : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
  },
  {
    id: "citationAccuracyChecked",
    header: "CitA",
    sortField: "citationAccuracyChecked",
    accessor: (row) => {
      const v = row.citationAccuracyChecked;
      return v > 0 ? <span className="text-xs tabular-nums text-muted-foreground">{v}</span> : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
  },
  {
    id: "citationAvgScore",
    header: "AvgA",
    sortField: "citationAvgScore",
    accessor: (row) => {
      const v = row.citationAvgScore;
      if (v == null) return <span className="text-muted-foreground/30 text-xs">-</span>;
      const color = v >= 0.8 ? "text-emerald-500" : v >= 0.5 ? "text-amber-500" : "text-red-400";
      return <span className={`text-xs tabular-nums font-medium ${color}`}>{(v * 100).toFixed(0)}%</span>;
    },
  },

  // --- Structural ---
  {
    id: "backlinkCount",
    header: "BL",
    sortField: "backlinkCount",
    accessor: (row) => <span className="text-xs tabular-nums text-muted-foreground">{row.backlinkCount}</span>,
  },
  {
    id: "sectionCount",
    header: "Sec",
    sortField: "sectionCount",
    accessor: (row) => <span className="text-xs tabular-nums text-muted-foreground">{row.sectionCount}</span>,
  },
  {
    id: "unconvertedLinkCount",
    header: "Unconv",
    sortField: "unconvertedLinkCount",
    accessor: (row) => {
      const v = row.unconvertedLinkCount;
      return v > 0
        ? <span className="text-xs tabular-nums text-amber-500">{v}</span>
        : <span className="text-muted-foreground/30 text-xs">0</span>;
    },
  },

  // --- Boolean items ---
  {
    id: "booleans",
    header: "Bool",
    accessor: (row) => (
      <span className="inline-flex items-center gap-1">
        <BoolIcon value={row.llmSummary} label="LLM Summary" />
        <BoolIcon value={row.schedule} label="Update Schedule" />
        <BoolIcon value={row.entity} label="Entity" />
        <BoolIcon value={row.editHistory} label="Edit History" />
      </span>
    ),
  },

  // --- Coverage metrics (actual/target) ---
  {
    id: "tables",
    header: "Tbl",
    sortField: "tablesActual",
    accessor: (row) => <MetricCell actual={row.tablesActual} target={row.tablesTarget} status={row.tables} />,
  },
  {
    id: "diagrams",
    header: "Dia",
    sortField: "diagramsActual",
    accessor: (row) => <MetricCell actual={row.diagramsActual} target={row.diagramsTarget} status={row.diagrams} />,
  },
  {
    id: "internalLinks",
    header: "Int",
    sortField: "internalLinksActual",
    accessor: (row) => <MetricCell actual={row.internalLinksActual} target={row.internalLinksTarget} status={row.internalLinks} />,
  },
  {
    id: "externalLinks",
    header: "Ext",
    sortField: "externalLinksActual",
    accessor: (row) => <MetricCell actual={row.externalLinksActual} target={row.externalLinksTarget} status={row.externalLinks} />,
  },
  {
    id: "footnotes",
    header: "Fn",
    sortField: "footnotesActual",
    accessor: (row) => <MetricCell actual={row.footnotesActual} target={row.footnotesTarget} status={row.footnotes} />,
  },
  {
    id: "references",
    header: "Ref",
    sortField: "referencesActual",
    accessor: (row) => <MetricCell actual={row.referencesActual} target={row.referencesTarget} status={row.references} />,
  },
  {
    id: "quotes",
    header: "Qt",
    sortField: "quotesActual",
    accessor: (row) => <RatioCell actual={row.quotesActual} total={row.quotesTotal} status={row.quotes} />,
  },
  {
    id: "accuracy",
    header: "Acc",
    sortField: "accuracyActual",
    accessor: (row) => <RatioCell actual={row.accuracyActual} total={row.accuracyTotal} status={row.accuracy} />,
  },
];

// ---------------------------------------------------------------------------
// Presets — named column selections
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
    description: "Key quality, risk, and status metrics",
    columns: ["title", "quality", "readerImportance", "score", "riskLevel", "lastUpdated", "wordCount", "entityType", "category"],
    defaultSortId: "quality",
    defaultSortDir: "desc",
  },
  coverage: {
    label: "Coverage",
    description: "Structural completeness targets",
    columns: ["title", "score", "wordCount", "booleans", "tables", "diagrams", "internalLinks", "externalLinks", "footnotes", "references", "quotes", "accuracy"],
    defaultSortId: "score",
    defaultSortDir: "asc",
  },
  quality: {
    label: "Quality",
    description: "Quality ratings and importance scores",
    columns: ["title", "quality", "readerImportance", "researchImportance", "tacticalValue", "novelty", "rigor", "actionability", "completeness", "wordCount"],
    defaultSortId: "quality",
    defaultSortDir: "desc",
  },
  citations: {
    label: "Citations",
    description: "Citation health and accuracy",
    columns: ["title", "citationTotal", "citationWithQuotes", "citationAccuracyChecked", "citationAvgScore", "quotes", "accuracy", "quality", "wordCount"],
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
    defaultSortId: "quality",
    defaultSortDir: "desc",
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
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const mult = dir === "asc" ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") {
    return (a - b) * mult;
  }
  return String(a).localeCompare(String(b)) * mult;
}

function coverageStaticSort(a: PageCoverageItem, b: PageCoverageItem, sortId: string, dir: SortDir): number {
  if (sortId === "riskLevel") {
    const aVal = RISK_ORDER[a.riskLevel ?? ""] ?? 3;
    const bVal = RISK_ORDER[b.riskLevel ?? ""] ?? 3;
    return dir === "asc" ? aVal - bVal : bVal - aVal;
  }

  const key = sortId as keyof PageCoverageItem;
  const aVal = a[key];
  const bVal = b[key];
  return compareNullable(
    aVal as string | number | boolean | null,
    bVal as string | number | boolean | null,
    dir
  );
}

// ---------------------------------------------------------------------------
// Table component
// ---------------------------------------------------------------------------

export function CoverageTable({ data }: { data: PageCoverageItem[] }) {
  const [activePreset, setActivePreset] = useState<string>("overview");

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

      {/* SPT table — key forces re-mount when preset changes to reset column visibility */}
      <ServerPaginatedTable<PageCoverageItem>
        key={activePreset}
        columns={presetColumns}
        rows={data}
        searchFields={["title", "category", "entityType"]}
        rowKey={(row) => row.id}
        pageSize={50}
        defaultSortId={preset.defaultSortId}
        defaultSortDir={preset.defaultSortDir}
        searchPlaceholder="Search pages..."
        itemLabel="pages"
        showColumnPicker
        staticSort={coverageStaticSort}
      />
    </div>
  );
}
