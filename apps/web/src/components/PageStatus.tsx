import Link from "next/link";
import { cn } from "@lib/utils";
import { formatAge, formatFrequency } from "@lib/format";
import { GITHUB_REPO_URL } from "@lib/site-config";
import {
  detectPageType,
  PAGE_TYPE_INFO,
  CONTENT_FORMAT_INFO,
  type ContentFormat,
} from "@/lib/page-types";
import type { StructuredSummary, ChangeEntry, Page } from "@/data";
import { getRatioStatus } from "@/lib/coverage";
import type { CoverageStatus } from "@/lib/coverage";
import styles from "@/components/wiki/tooltip.module.css";

// ============================================================================
// TYPES
// ============================================================================

interface PageMetrics {
  wordCount: number;
  tableCount: number;
  diagramCount: number;
  internalLinks: number;
  externalLinks: number;
  footnoteCount: number;
  bulletRatio: number;
  sectionCount: number;
  hasOverview: boolean;
  structuralScore: number;
}

interface PageIssues {
  unconvertedLinkCount?: number;
  redundancy?: {
    maxSimilarity: number;
    similarPages: Array<{
      id: string;
      title: string;
      path: string;
      similarity: number;
    }>;
  };
}

interface CitationHealth {
  total: number;
  withQuotes: number;
  verified: number;
  accuracyChecked: number;
  accurate: number;
  inaccurate: number;
  avgScore: number | null;
}

interface PageRatings {
  novelty?: number;
  rigor?: number;
  actionability?: number;
  completeness?: number;
}

export interface PageStatusProps {
  quality?: number;
  importance?: number;
  researchImportance?: number;
  llmSummary?: string;
  structuredSummary?: StructuredSummary;
  lastEdited?: string;
  updateFrequency?: number;
  evergreen?: boolean;
  todo?: string;
  todos?: string[];
  wordCount?: number;
  backlinkCount?: number;
  metrics?: PageMetrics;
  suggestedQuality?: number;
  issues?: PageIssues;
  changeHistory?: ChangeEntry[];
  pageType?: string;
  pathname?: string;
  contentFormat?: ContentFormat;
  hasEntity?: boolean;
  resourceCount?: number;
  citationHealth?: CitationHealth;
  ratings?: PageRatings;
  factCount?: number;
  coverage?: Page["coverage"];
}

// ============================================================================
// HELPERS
// ============================================================================

const qualityLabels: Record<string, string> = {
  comprehensive: "Comprehensive",
  good: "Good",
  adequate: "Adequate",
  draft: "Draft",
  stub: "Stub",
};

const importanceLabels: Record<string, string> = {
  essential: "Essential",
  high: "High",
  useful: "Useful",
  reference: "Reference",
  peripheral: "Peripheral",
};

const researchLabels: Record<string, string> = {
  critical: "Critical",
  high: "High",
  moderate: "Moderate",
  low: "Low",
  minimal: "Minimal",
};

const qualityColors: Record<string, { ring: string; text: string }> = {
  comprehensive: { ring: "#10b981", text: "text-emerald-500" },
  good: { ring: "#3b82f6", text: "text-blue-500" },
  adequate: { ring: "#f59e0b", text: "text-amber-500" },
  draft: { ring: "#ef4444", text: "text-red-500" },
  stub: { ring: "#94a3b8", text: "text-slate-400" },
};

const importanceColors: Record<string, { ring: string; text: string }> = {
  essential: { ring: "#a855f7", text: "text-purple-500" },
  high: { ring: "#8b5cf6", text: "text-violet-500" },
  useful: { ring: "#6366f1", text: "text-indigo-500" },
  reference: { ring: "#94a3b8", text: "text-slate-400" },
  peripheral: { ring: "#94a3b8", text: "text-slate-400" },
};

const researchColors: Record<string, { ring: string; text: string }> = {
  critical: { ring: "#f97316", text: "text-orange-500" },
  high: { ring: "#f59e0b", text: "text-amber-500" },
  moderate: { ring: "#eab308", text: "text-yellow-500" },
  low: { ring: "#94a3b8", text: "text-slate-400" },
  minimal: { ring: "#94a3b8", text: "text-slate-400" },
};

function getQualityLevel(quality: number): string {
  if (quality >= 80) return "comprehensive";
  if (quality >= 60) return "good";
  if (quality >= 40) return "adequate";
  if (quality >= 20) return "draft";
  return "stub";
}

function getImportanceLevel(importance: number): string {
  if (importance >= 90) return "essential";
  if (importance >= 70) return "high";
  if (importance >= 50) return "useful";
  if (importance >= 30) return "reference";
  return "peripheral";
}

function getResearchLevel(score: number): string {
  if (score >= 90) return "critical";
  if (score >= 70) return "high";
  if (score >= 50) return "moderate";
  if (score >= 30) return "low";
  return "minimal";
}

function formatWordCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}

function getUpdateStatus(
  lastEdited: string,
  updateFrequency: number
): { label: string; isOverdue: boolean; daysUntil: number } {
  const today = new Date();
  const edited = new Date(lastEdited);
  const daysSince = Math.floor(
    (today.getTime() - edited.getTime()) / (1000 * 60 * 60 * 24)
  );
  const daysUntil = updateFrequency - daysSince;

  if (daysUntil < 0) {
    return {
      label: `Overdue by ${Math.abs(daysUntil)} days`,
      isOverdue: true,
      daysUntil,
    };
  }
  if (daysUntil === 0) {
    return { label: "Due today", isOverdue: true, daysUntil: 0 };
  }
  if (daysUntil <= 7) {
    return {
      label: `Due in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`,
      isOverdue: false,
      daysUntil,
    };
  }
  return {
    label: `Due in ${Math.round(daysUntil / 7)} weeks`,
    isOverdue: false,
    daysUntil,
  };
}

// ============================================================================
// SVG ICONS
// ============================================================================

function IconTable({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <line x1="2" y1="6" x2="14" y2="6" />
      <line x1="6" y1="6" x2="6" y2="14" />
    </svg>
  );
}

function IconDiagram({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <polyline points="2,12 6,6 10,9 14,3" />
      <polyline points="11,3 14,3 14,6" />
    </svg>
  );
}

function IconLink({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M6.5 9.5l3-3M9 5l1.5-1.5a2.12 2.12 0 013 3L12 8M7 11l-1.5 1.5a2.12 2.12 0 01-3-3L4 8" />
    </svg>
  );
}

function IconBook({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 3h4.5a2 2 0 012 2v8.5a1.5 1.5 0 00-1.5-1.5H2V3zM14 3H9.5a2 2 0 00-2 2v8.5a1.5 1.5 0 011.5-1.5H14V3z" />
    </svg>
  );
}

function IconCalendar({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <line x1="5" y1="1.5" x2="5" y2="4.5" strokeLinecap="round" />
      <line x1="11" y1="1.5" x2="11" y2="4.5" strokeLinecap="round" />
      <line x1="2" y1="7" x2="14" y2="7" />
    </svg>
  );
}

function IconAlert({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1.5l6.5 12H1.5L8 1.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <line x1="8" y1="6.5" x2="8" y2="9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconInfo({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <line x1="8" y1="7" x2="8" y2="11" strokeLinecap="round" />
      <circle cx="8" cy="5" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconCheck({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3.5 8 6.5 11 12.5 5" />
    </svg>
  );
}

function IconX({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4.5" y1="4.5" x2="11.5" y2="11.5" />
      <line x1="11.5" y1="4.5" x2="4.5" y2="11.5" />
    </svg>
  );
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

function PageTypeBadge({
  pageType,
  pathname,
}: {
  pageType?: string;
  pathname?: string;
}) {
  const detectedType = detectPageType(pathname || "", pageType);
  const info = PAGE_TYPE_INFO[detectedType];

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold border border-transparent ${info.color}`}
    >
      {info.label}
    </span>
  );
}

function ContentFormatBadge({
  contentFormat,
}: {
  contentFormat?: ContentFormat;
}) {
  const format = contentFormat || "article";
  const info = CONTENT_FORMAT_INFO[format];
  if (format === "article") return null; // Don't show badge for default format

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold border border-transparent ${info.color}`}
    >
      {info.label}
    </span>
  );
}

/** Compact score bar: colored left accent + number + label + level */
function ScoreBar({
  value,
  max,
  label,
  levelLabel,
  color,
  tooltipTitle,
  tooltipDesc,
  extraTooltip,
}: {
  value: number;
  max: number;
  label: string;
  levelLabel: string;
  color: string;
  tooltipTitle: string;
  tooltipDesc: string;
  extraTooltip?: React.ReactNode;
}) {
  const pct = Math.round((value / max) * 100);
  return (
    <span className={cn(styles.wrapper, "cursor-help flex items-center gap-2 min-w-0")}>
      <span className="flex items-center gap-2 min-w-0">
        {/* Thin progress accent */}
        <span className="relative shrink-0 w-1 h-6 rounded-full bg-border overflow-hidden">
          <span
            className="absolute bottom-0 left-0 w-full rounded-full transition-all duration-300"
            style={{ height: `${pct}%`, backgroundColor: color }}
          />
        </span>
        <span className="tabular-nums text-sm font-bold text-foreground leading-none">
          {value}
        </span>
        <span className="flex flex-col min-w-0">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground leading-none">
            {label}
          </span>
          <span className="text-[11px] font-semibold leading-tight truncate" style={{ color }}>
            {levelLabel}
          </span>
        </span>
      </span>
      <span
        className={cn(
          styles.tooltip,
          "absolute left-0 top-full mt-1 z-50 w-[240px] p-3 bg-popover text-popover-foreground border rounded-md shadow-md pointer-events-none opacity-0 invisible"
        )}
        role="tooltip"
      >
        <span className="block font-semibold text-foreground text-sm mb-1">
          {tooltipTitle}
        </span>
        <span className="block text-muted-foreground text-xs leading-snug">
          {tooltipDesc}
        </span>
        {extraTooltip}
      </span>
    </span>
  );
}

function QualityDisplay({
  quality,
  suggestedQuality,
}: {
  quality: number;
  suggestedQuality?: number;
}) {
  const level = getQualityLevel(quality);
  const colors = qualityColors[level];
  const hasDiscrepancy =
    suggestedQuality !== undefined &&
    Math.abs(quality - suggestedQuality) >= 20;

  return (
    <ScoreBar
      value={quality}
      max={100}
      label="Quality"
      levelLabel={`${qualityLabels[level]}${hasDiscrepancy ? " •" : ""}`}
      color={colors.ring}
      tooltipTitle={`Quality: ${quality}/100`}
      tooltipDesc="LLM-assigned rating of overall page quality, considering depth, accuracy, and completeness."
      extraTooltip={
        hasDiscrepancy ? (
          <span className="block mt-2 text-xs text-amber-500">
            Structure suggests {suggestedQuality}
          </span>
        ) : undefined
      }
    />
  );
}

function ImportanceDisplay({ importance }: { importance: number }) {
  const level = getImportanceLevel(importance);
  const colors = importanceColors[level];

  return (
    <ScoreBar
      value={importance}
      max={100}
      label="Importance"
      levelLabel={importanceLabels[level]}
      color={colors.ring}
      tooltipTitle={`Importance: ${importance}/100`}
      tooltipDesc="How central this topic is to AI safety. Higher scores mean greater relevance to understanding or mitigating AI risk."
    />
  );
}

function ResearchDisplay({ researchImportance }: { researchImportance: number }) {
  const level = getResearchLevel(researchImportance);
  const colors = researchColors[level];

  return (
    <ScoreBar
      value={researchImportance}
      max={100}
      label="Research"
      levelLabel={researchLabels[level]}
      color={colors.ring}
      tooltipTitle={`Research Value: ${researchImportance}/100`}
      tooltipDesc="How much value deeper investigation of this topic could yield. Higher scores indicate under-explored topics with high insight potential."
    />
  );
}

interface Issue {
  type: "warning" | "info";
  label: string;
  message: string;
}

function SectionHeader({
  children,
  count,
  countColor = "bg-amber-500/15 text-amber-500",
}: {
  children: React.ReactNode;
  count?: number;
  countColor?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
      {children}
      {count !== undefined && (
        <span
          className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ${countColor}`}
        >
          {count}
        </span>
      )}
    </div>
  );
}

function IssuesSection({
  issues,
  metrics,
  quality,
  suggestedQuality,
  lastEdited,
  contentFormat,
  evergreen,
}: {
  issues?: PageIssues;
  metrics?: PageMetrics;
  quality?: number;
  suggestedQuality?: number;
  lastEdited?: string;
  contentFormat?: ContentFormat;
  evergreen?: boolean;
}) {
  const detectedIssues: Issue[] = [];

  if (quality !== undefined && suggestedQuality !== undefined) {
    const diff = quality - suggestedQuality;
    if (Math.abs(diff) >= 20) {
      detectedIssues.push({
        type: "warning",
        label: "Quality",
        message:
          diff > 0
            ? `Rated ${quality} but structure suggests ${suggestedQuality} (overrated by ${diff} points)`
            : `Rated ${quality} but structure suggests ${suggestedQuality} (underrated by ${Math.abs(diff)} points)`,
      });
    }
  }

  if (issues?.unconvertedLinkCount && issues.unconvertedLinkCount > 0) {
    detectedIssues.push({
      type: "info",
      label: "Links",
      message: `${issues.unconvertedLinkCount} link${issues.unconvertedLinkCount > 1 ? "s" : ""} could use <R> components`,
    });
  }

  if (issues?.redundancy && issues.redundancy.maxSimilarity >= 40) {
    const topSimilar = issues.redundancy.similarPages[0];
    detectedIssues.push({
      type: "warning",
      label: "Redundancy",
      message: `${issues.redundancy.maxSimilarity}% similar to "${topSimilar?.title}"`,
    });
  }

  if (lastEdited && evergreen !== false) {
    const days = Math.floor(
      (Date.now() - new Date(lastEdited).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (days > 60) {
      detectedIssues.push({
        type: "info",
        label: "Stale",
        message: `Last edited ${days} days ago - may need review`,
      });
    }
  }

  if (metrics) {
    // Only suggest adding tables/diagrams for article-format pages
    const format = contentFormat || "article";
    if (format === "article" && metrics.tableCount === 0 && metrics.diagramCount === 0) {
      detectedIssues.push({
        type: "info",
        label: "Structure",
        message: "No tables or diagrams - consider adding visual content",
      });
    }
  }

  if (detectedIssues.length === 0) return null;

  return (
    <div className="border-t border-border px-3.5 pt-2 pb-2.5">
      <SectionHeader count={detectedIssues.length}>Issues</SectionHeader>
      <div className="flex flex-col gap-1">
        {detectedIssues.map((issue, i) => (
          <div
            key={i}
            className={`flex items-start gap-1.5 rounded-md px-2 py-1 text-xs leading-snug ${
              issue.type === "warning" ? "bg-amber-500/[0.08]" : "bg-muted"
            }`}
          >
            <span
              className={`shrink-0 flex items-center mt-px ${
                issue.type === "warning"
                  ? "text-amber-500"
                  : "text-muted-foreground"
              }`}
            >
              {issue.type === "warning" ? <IconAlert /> : <IconInfo />}
            </span>
            <span
              className={`shrink-0 text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-px mt-px ${
                issue.type === "warning"
                  ? "bg-amber-500/15 text-amber-500"
                  : "bg-border text-muted-foreground"
              }`}
            >
              {issue.label}
            </span>
            <span className="text-muted-foreground">{issue.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

// ============================================================================
// CONTENT COVERAGE SECTION
// ============================================================================

interface BooleanCoverageItem {
  label: string;
  present: boolean;
  detail?: string;
  hint?: string;
  description: string;
  anchor: string;
}

interface NumericMetric {
  label: string;
  actual: number;
  target?: number; // undefined = ratio-based (no target)
  ratio?: string; // e.g. "83/87" for quotes/accuracy
  hint?: string;
  description: string;
  anchor: string;
}

function getRecommendedMetrics(
  wordCount: number,
  contentFormat: ContentFormat
): {
  tables: number;
  diagrams: number;
  internalLinks: number;
  externalLinks: number;
  footnotes: number;
  references: number;
} {
  // Calibrated against high-quality pages (quality >= 70):
  // tables ~4.4/kw, diagrams ~0.4/kw, intLinks ~9.8/kw, footnotes ~3.3/kw
  const kWords = wordCount / 1000;

  if (contentFormat === "table") {
    return {
      tables: Math.max(2, Math.round(kWords * 5)),
      diagrams: Math.max(0, Math.round(kWords * 0.3)),
      internalLinks: Math.max(3, Math.round(kWords * 5)),
      externalLinks: Math.max(1, Math.round(kWords * 3)),
      footnotes: Math.max(1, Math.round(kWords * 2)),
      references: Math.max(1, Math.round(kWords * 2)),
    };
  }
  if (contentFormat === "diagram") {
    return {
      tables: Math.max(0, Math.round(kWords * 1)),
      diagrams: Math.max(1, Math.round(kWords * 1)),
      internalLinks: Math.max(3, Math.round(kWords * 5)),
      externalLinks: Math.max(1, Math.round(kWords * 3)),
      footnotes: Math.max(1, Math.round(kWords * 2)),
      references: Math.max(1, Math.round(kWords * 2)),
    };
  }
  if (contentFormat === "index" || contentFormat === "dashboard") {
    return {
      tables: Math.max(0, Math.round(kWords * 1)),
      diagrams: 0,
      internalLinks: Math.max(5, Math.round(kWords * 8)),
      externalLinks: Math.max(0, Math.round(kWords * 2)),
      footnotes: 0,
      references: Math.max(0, Math.round(kWords * 1)),
    };
  }

  // Default: article format (calibrated from q>=70 pages)
  return {
    tables: Math.max(1, Math.round(kWords * 4)),
    diagrams: Math.max(0, Math.round(kWords * 0.4)),
    internalLinks: Math.max(3, Math.round(kWords * 8)),
    externalLinks: Math.max(1, Math.round(kWords * 5)),
    footnotes: Math.max(2, Math.round(kWords * 3)),
    references: Math.max(1, Math.round(kWords * 3)),
  };
}

function getMetricStatus(actual: number, target?: number): CoverageStatus {
  if (target === undefined || target === 0) {
    return actual > 0 ? "green" : "red";
  }
  if (actual >= target) return "green";
  if (actual > 0) return "amber";
  return "red";
}

const statusIcons = {
  green: <IconCheck className="shrink-0 text-emerald-500" />,
  amber: (
    <span className="shrink-0 w-[14px] h-[14px] flex items-center justify-center text-amber-500 text-[11px] font-bold">
      –
    </span>
  ),
  red: <IconX className="shrink-0 text-red-400/60" />,
};

function ContentCoverageSection({
  structuredSummary,
  llmSummary,
  updateFrequency,
  hasEntity,
  metrics,
  resourceCount,
  citationHealth,
  changeHistory,
  wordCount,
  contentFormat,
  ratings,
  factCount,
  coverage,
}: {
  structuredSummary?: StructuredSummary;
  llmSummary?: string;
  updateFrequency?: number;
  hasEntity?: boolean;
  metrics?: PageMetrics;
  resourceCount?: number;
  citationHealth?: CitationHealth;
  changeHistory?: ChangeEntry[];
  wordCount?: number;
  contentFormat?: ContentFormat;
  ratings?: PageRatings;
  factCount?: number;
  coverage?: Page["coverage"];
}) {
  // Use pre-computed coverage targets when available, else compute from scratch
  const recommended = coverage?.targets ?? getRecommendedMetrics(wordCount || 0, contentFormat || "article");

  // --- Boolean items (yes/no chips) ---
  const booleanItems: BooleanCoverageItem[] = [
    {
      label: "LLM summary",
      present: !!llmSummary,
      hint: "crux content improve <id>",
      description: "Basic text summary used in search results, entity link tooltips, info boxes, and related page cards.",
      anchor: "structured-summary",
    },
    {
      label: "Structured summary",
      present: !!structuredSummary,
      hint: "crux content improve <id> --tier=standard",
      description: "Rich summary with one-liner, key points, and bottom line. Shown in Key Takeaways and PageStatus.",
      anchor: "structured-summary",
    },
    {
      label: "Schedule",
      present: updateFrequency != null,
      hint: "Set updateFrequency in frontmatter",
      description: "How often the page should be refreshed. Drives the overdue tracking system.",
      anchor: "update-schedule",
    },
    {
      label: "Entity",
      present: !!hasEntity,
      hint: "Add entity YAML in data/entities/",
      description: "YAML entity definition with type, description, and related entries.",
      anchor: "entity-data",
    },
    {
      label: "Edit history",
      present: (changeHistory?.length ?? 0) > 0,
      detail: changeHistory && changeHistory.length > 0 ? `${changeHistory.length}` : undefined,
      hint: "crux edit-log view <id>",
      description: "Tracked changes from improve pipeline runs and manual edits.",
      anchor: "edit-history",
    },
  ];

  // --- Numeric metrics (table rows) ---
  const tableCount = metrics?.tableCount ?? 0;
  const diagramCount = metrics?.diagramCount ?? 0;
  const internalLinks = metrics?.internalLinks ?? 0;
  const externalLinks = metrics?.externalLinks ?? 0;
  const footnoteCount = metrics?.footnoteCount ?? 0;
  const refCount = resourceCount ?? 0;
  const quoteNum = citationHealth?.withQuotes ?? 0;
  const quoteTotal = citationHealth?.total ?? 0;
  const accNum = citationHealth?.accuracyChecked ?? 0;
  const accTotal = citationHealth?.total ?? 0;

  const numericMetrics: NumericMetric[] = [
    {
      label: "Tables",
      actual: tableCount,
      target: recommended.tables,
      hint: "Add data tables to the page",
      description: "Data tables for structured comparisons and reference material.",
      anchor: "tables-diagrams",
    },
    {
      label: "Diagrams",
      actual: diagramCount,
      target: recommended.diagrams,
      hint: "Add Mermaid diagrams or Squiggle models",
      description: "Visual content — Mermaid diagrams, charts, or Squiggle estimate models.",
      anchor: "tables-diagrams",
    },
    {
      label: "Int. links",
      actual: internalLinks,
      target: recommended.internalLinks,
      hint: "Add links to other wiki pages",
      description: "Links to other wiki pages. More internal links = better graph connectivity.",
      anchor: "tables-diagrams",
    },
    {
      label: "Ext. links",
      actual: externalLinks,
      target: recommended.externalLinks,
      hint: "Add links to external sources",
      description: "Links to external websites, papers, and resources outside the wiki.",
      anchor: "tables-diagrams",
    },
    {
      label: "Footnotes",
      actual: footnoteCount,
      target: recommended.footnotes,
      hint: "Add [^N] footnote citations",
      description: "Footnote citations [^N] with source references at the bottom of the page.",
      anchor: "references",
    },
    {
      label: "References",
      actual: refCount,
      target: recommended.references,
      hint: "Add <R> resource links",
      description: "Curated external resources linked via <R> components or cited_by in YAML.",
      anchor: "references",
    },
    {
      label: "Quotes",
      actual: quoteNum,
      ratio: quoteTotal > 0 ? `${quoteNum}/${quoteTotal}` : undefined,
      hint: "crux citations extract-quotes <id>",
      description: "Supporting quotes extracted from cited sources to back up page claims.",
      anchor: "citation-quotes",
    },
    {
      label: "Accuracy",
      actual: accNum,
      ratio: accTotal > 0 ? `${accNum}/${accTotal}` : undefined,
      hint: "crux citations verify <id>",
      description: "Citations verified against their sources for factual accuracy.",
      anchor: "accuracy-checked",
    },
  ];

  // --- Info-only items (no pass/fail, just data) ---
  const infoItems: { label: string; value: string; description: string }[] = [];

  if (ratings) {
    const ratingParts: string[] = [];
    if (ratings.novelty != null) ratingParts.push(`N:${ratings.novelty}`);
    if (ratings.rigor != null) ratingParts.push(`R:${ratings.rigor}`);
    if (ratings.actionability != null) ratingParts.push(`A:${ratings.actionability}`);
    if (ratings.completeness != null) ratingParts.push(`C:${ratings.completeness}`);
    if (ratingParts.length > 0) {
      infoItems.push({
        label: "Ratings",
        value: ratingParts.join(" "),
        description: "Sub-quality ratings: Novelty, Rigor, Actionability, Completeness (0-10 scale).",
      });
    }
  }

  if (factCount != null && factCount > 0) {
    infoItems.push({
      label: "Facts",
      value: `${factCount}`,
      description: "Canonical facts defined for this entity in data/facts/ YAML. Used by <F> components.",
    });
  }

  // --- Scoring ---
  // Use pre-computed coverage score when available, with live citation overrides
  let presentCount: number;
  if (coverage) {
    // Start from pre-computed score, but re-evaluate quotes & accuracy with live data
    const liveQuotesStatus = getRatioStatus(quoteNum, quoteTotal);
    const liveAccuracyStatus = getRatioStatus(accNum, accTotal);
    const buildQuotesGreen = coverage.items.quotes === "green" ? 1 : 0;
    const buildAccuracyGreen = coverage.items.accuracy === "green" ? 1 : 0;
    const liveQuotesGreen = liveQuotesStatus === "green" ? 1 : 0;
    const liveAccuracyGreen = liveAccuracyStatus === "green" ? 1 : 0;
    presentCount = coverage.passing - buildQuotesGreen - buildAccuracyGreen + liveQuotesGreen + liveAccuracyGreen;
  } else {
    const booleanPassing = booleanItems.filter((i) => i.present).length;
    const numericPassing = numericMetrics.filter((m) => {
      if (m.ratio !== undefined) {
        const total = m.label === "Quotes" ? quoteTotal : accTotal;
        return getRatioStatus(m.actual, total) === "green";
      }
      return getMetricStatus(m.actual, m.target) === "green";
    }).length;
    presentCount = booleanPassing + numericPassing;
  }
  const total = booleanItems.length + numericMetrics.length;
  const pct = presentCount / total;
  const badgeColor =
    pct >= 0.75
      ? "bg-emerald-500/15 text-emerald-500"
      : pct >= 0.5
        ? "bg-amber-500/15 text-amber-500"
        : "bg-red-500/15 text-red-500";

  return (
    <div className="border-t border-border px-3.5 pt-2 pb-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
        Content
        <span
          className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ${badgeColor}`}
        >
          {presentCount}/{total}
        </span>
      </div>

      <div className="flex gap-2">
        {/* Boolean items — stacked vertically */}
        <div className="flex flex-col gap-1">
          {booleanItems.map((item) => (
            <span
              key={item.label}
              className={cn(
                styles.wrapper,
                "!inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] cursor-help",
                item.present
                  ? "border-emerald-500/20 bg-emerald-500/[0.04] text-foreground"
                  : "border-border bg-muted/50 text-muted-foreground/50"
              )}
            >
              {item.present ? (
                <IconCheck className="shrink-0 text-emerald-500" />
              ) : (
                <IconX className="shrink-0 text-muted-foreground/30" />
              )}
              <Link
                href={`/internal/coverage-guide#${item.anchor}`}
                className="no-underline hover:underline"
                style={{ color: "inherit" }}
              >
                {item.label}
              </Link>
              {item.present && item.detail && (
                <span className="tabular-nums text-[10px] text-muted-foreground font-medium">
                  {item.detail}
                </span>
              )}
              <span
                className={cn(
                  styles.tooltip,
                  "absolute left-0 top-full mt-1 z-50 w-[260px] p-2.5 bg-popover text-popover-foreground border rounded-md shadow-md pointer-events-none opacity-0 invisible"
                )}
                role="tooltip"
              >
                <span className="block font-semibold text-foreground text-xs mb-1">
                  {item.label}
                </span>
                <span className="block text-muted-foreground text-[11px] leading-snug whitespace-normal">
                  {item.description}
                </span>
                {!item.present && item.hint && (
                  <span className="block mt-1.5 pt-1.5 border-t border-border text-muted-foreground text-[11px] font-mono whitespace-normal">
                    {item.hint}
                  </span>
                )}
              </span>
            </span>
          ))}
        </div>

        {/* Numeric metrics table — bordered */}
        <div className="rounded-md border border-border">
          {numericMetrics.map((m, i) => {
            const isRatio = m.ratio !== undefined;
            const status = isRatio
              ? getRatioStatus(m.actual, m.label === "Quotes" ? quoteTotal : accTotal)
              : getMetricStatus(m.actual, m.target);

            return (
              <span
                key={m.label}
                className={cn(
                  styles.wrapper,
                  "!flex items-center gap-1.5 px-2 py-[3px] text-[11px] cursor-help",
                  i > 0 && "border-t border-border"
                )}
              >
                {statusIcons[status]}
                <Link
                  href={`/internal/coverage-guide#${m.anchor}`}
                  className="no-underline hover:underline w-[62px] shrink-0 text-muted-foreground"
                  style={{ color: "inherit" }}
                >
                  {m.label}
                </Link>
                <span className="tabular-nums font-medium text-foreground w-[36px] text-right shrink-0">
                  {isRatio ? m.ratio : m.actual}
                </span>
                {!isRatio && m.target !== undefined && m.target > 0 && (
                  <span className="tabular-nums text-[10px] text-muted-foreground/50 shrink-0">
                    / ~{m.target}
                  </span>
                )}
                <span
                  className={cn(
                    styles.tooltip,
                    "absolute left-0 top-full mt-1 z-50 w-[260px] p-2.5 bg-popover text-popover-foreground border rounded-md shadow-md pointer-events-none opacity-0 invisible"
                  )}
                  role="tooltip"
                >
                  <span className="block font-semibold text-foreground text-xs mb-1">
                    {m.label}
                  </span>
                  <span className="block text-muted-foreground text-[11px] leading-snug whitespace-normal">
                    {m.description}
                  </span>
                  {status !== "green" && m.hint && (
                    <span className="block mt-1.5 pt-1.5 border-t border-border text-muted-foreground text-[11px] font-mono whitespace-normal">
                      {m.hint}
                    </span>
                  )}
                </span>
              </span>
            );
          })}
          {/* Info-only rows — no pass/fail, just data */}
          {infoItems.map((item) => (
            <span
              key={item.label}
              className={cn(
                styles.wrapper,
                "!flex items-center gap-1.5 px-2 py-[3px] text-[11px] cursor-help border-t border-border bg-muted/30"
              )}
            >
              <IconInfo className="shrink-0 text-muted-foreground/50" />
              <span className="w-[62px] shrink-0 text-muted-foreground">
                {item.label}
              </span>
              <span className="tabular-nums text-[10px] text-muted-foreground font-medium">
                {item.value}
              </span>
              <span
                className={cn(
                  styles.tooltip,
                  "absolute left-0 top-full mt-1 z-50 w-[260px] p-2.5 bg-popover text-popover-foreground border rounded-md shadow-md pointer-events-none opacity-0 invisible"
                )}
                role="tooltip"
              >
                <span className="block font-semibold text-foreground text-xs mb-1">
                  {item.label}
                </span>
                <span className="block text-muted-foreground text-[11px] leading-snug whitespace-normal">
                  {item.description}
                </span>
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// CHANGE HISTORY SECTION
// ============================================================================

function ChangeHistorySection({
  changeHistory,
}: {
  changeHistory?: ChangeEntry[];
}) {
  if (!changeHistory || changeHistory.length === 0) return null;

  return (
    <div className="border-t border-border px-3.5 pt-2 pb-2.5">
      <SectionHeader
        count={changeHistory.length}
        countColor="bg-sky-500/15 text-sky-500"
      >
        Change History
      </SectionHeader>
      <div className="flex flex-col gap-1">
        {changeHistory.map((entry, index) => (
          <div
            key={index}
            className="rounded-md bg-sky-500/[0.06] px-2.5 py-1.5 text-xs"
          >
            <div className="flex items-center gap-1.5">
              <IconCalendar className="shrink-0 text-sky-500" />
              <span className="font-medium text-foreground">
                {entry.title}
              </span>
              {entry.pr && (
                <a
                  href={`${GITHUB_REPO_URL}/pull/${entry.pr}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-sky-500 hover:text-sky-600 no-underline"
                  title={`PR #${entry.pr}`}
                >
                  #{entry.pr}
                </a>
              )}
              <span className="text-muted-foreground">
                {formatAge(entry.date)}
              </span>
            </div>
            {entry.summary && (
              <p className="mt-0.5 ml-[18px] text-muted-foreground leading-relaxed line-clamp-2">
                {entry.summary}
              </p>
            )}
            {(entry.model || entry.duration || entry.cost) && (
              <p className="mt-0.5 ml-[18px] text-muted-foreground/60 text-[11px]">
                {[entry.model, entry.duration, entry.cost]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PageStatus({
  quality,
  importance,
  researchImportance,
  llmSummary,
  structuredSummary,
  lastEdited,
  updateFrequency,
  evergreen,
  todo,
  todos,
  wordCount,
  backlinkCount,
  metrics,
  suggestedQuality,
  changeHistory,
  issues,
  pageType,
  pathname,
  contentFormat,
  hasEntity,
  resourceCount,
  citationHealth,
  ratings,
  factCount,
  coverage,
}: PageStatusProps) {
  const detectedType = detectPageType(pathname || "", pageType);

  const hasEditorialContent =
    quality ||
    importance ||
    researchImportance ||
    llmSummary ||
    structuredSummary ||
    lastEdited ||
    todo ||
    (todos && todos.length > 0) ||
    (changeHistory && changeHistory.length > 0);
  if (!hasEditorialContent) {
    return null;
  }

  const metaItems: React.ReactNode[] = [];
  if (lastEdited) metaItems.push(`Edited ${formatAge(lastEdited)}`);
  if (wordCount && wordCount > 0) metaItems.push(`${formatWordCount(wordCount)} words`);
  if (backlinkCount && backlinkCount > 0) metaItems.push(`${backlinkCount} backlinks`);

  const updateStatus =
    lastEdited && updateFrequency
      ? getUpdateStatus(lastEdited, updateFrequency)
      : null;

  // Add update schedule info to meta items
  if (evergreen === false) {
    metaItems.push("Point-in-time");
  } else if (updateFrequency) {
    metaItems.push(
      <span key="schedule" className="inline-flex items-center gap-1">
        Updated {formatFrequency(updateFrequency)}
        {updateStatus && (
          <>
            <span className="mx-1 inline-block size-[3px] rounded-full bg-border" />
            <span className={updateStatus.isOverdue ? "font-medium text-amber-500" : ""}>
              {updateStatus.label}
            </span>
          </>
        )}
      </span>
    );
  }

  return (
    <div className="page-status page-status-dev-only mb-6 rounded-xl border border-border bg-card text-[13px] shadow-sm">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-muted px-3.5 py-2 rounded-t-xl">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Page Status
          </span>
          <PageTypeBadge pageType={pageType} pathname={pathname} />
          <ContentFormatBadge contentFormat={contentFormat} />
        </div>
        <div className="flex items-center gap-0 text-xs text-muted-foreground">
          {metaItems.map((item, i) => (
            <span key={i} className="flex items-center">
              {i > 0 && (
                <span className="mx-2 inline-block size-[3px] rounded-full bg-border" />
              )}
              {item}
            </span>
          ))}
        </div>
      </div>

      {/* Ratings — editorial judgments */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-3.5 py-2.5">
        {quality !== undefined && quality > 0 && (
          <QualityDisplay quality={quality} suggestedQuality={suggestedQuality} />
        )}
        {importance !== undefined && (
          <ImportanceDisplay importance={importance} />
        )}
        {researchImportance !== undefined && (
          <ResearchDisplay researchImportance={researchImportance} />
        )}
      </div>

      {/* Summary — structured if available, else flat llmSummary */}
      {structuredSummary ? (
        <div className="border-t border-border px-3.5 pt-2 pb-2.5">
          <SectionHeader>Summary</SectionHeader>
          <p className="m-0 mb-2 text-[13px] leading-relaxed text-foreground font-medium">
            {structuredSummary.oneLiner}
          </p>
          <ul className="m-0 mb-2 pl-4 flex flex-col gap-0.5">
            {structuredSummary.keyPoints.map((point, i) => (
              <li key={i} className="text-[13px] leading-relaxed text-muted-foreground list-disc">
                {point}
              </li>
            ))}
          </ul>
          <div className="flex items-start gap-1.5 rounded-md bg-indigo-500/[0.06] px-2.5 py-1.5 text-[13px] leading-relaxed text-foreground/90">
            <span className="shrink-0 text-indigo-500 font-semibold text-[11px] uppercase tracking-wide mt-px">
              Bottom line
            </span>
            <span>{structuredSummary.bottomLine}</span>
          </div>
        </div>
      ) : llmSummary ? (
        <div className="border-t border-border px-3.5 pt-2 pb-2.5">
          <SectionHeader>Summary</SectionHeader>
          <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">
            {llmSummary}
          </p>
        </div>
      ) : null}

      {/* Content — boolean chips + numeric metrics table */}
      <ContentCoverageSection
        structuredSummary={structuredSummary}
        llmSummary={llmSummary}
        updateFrequency={updateFrequency}
        hasEntity={hasEntity}
        metrics={metrics}
        resourceCount={resourceCount}
        citationHealth={citationHealth}
        changeHistory={changeHistory}
        wordCount={wordCount}
        contentFormat={contentFormat}
        ratings={ratings}
        factCount={factCount}
        coverage={coverage}
      />

      {/* Change history */}
      <ChangeHistorySection changeHistory={changeHistory} />

      {/* Issues */}
      <IssuesSection
        issues={issues}
        metrics={metrics}
        quality={quality}
        suggestedQuality={suggestedQuality}
        lastEdited={lastEdited}
        contentFormat={contentFormat}
        evergreen={evergreen}
      />

      {/* Single todo */}
      {todo && (
        <div className="border-t border-border px-3.5 pt-2 pb-2.5">
          <SectionHeader count={1} countColor="bg-violet-500/15 text-violet-500">
            Todo
          </SectionHeader>
          <div className="flex items-start gap-1.5 rounded-md bg-violet-500/[0.06] px-2 py-1 text-xs text-muted-foreground">
            <IconCheck className="shrink-0 text-violet-500 mt-px" />
            <span>{todo}</span>
          </div>
        </div>
      )}

      {/* Multiple todos */}
      {todos && todos.length > 0 && (
        <div className="border-t border-border px-3.5 pt-2 pb-2.5">
          <SectionHeader count={todos.length} countColor="bg-violet-500/15 text-violet-500">
            TODOs
          </SectionHeader>
          <div className="flex flex-col gap-1">
            {todos.map((item, index) => (
              <div
                key={index}
                className="flex items-start gap-1.5 rounded-md bg-violet-500/[0.06] px-2 py-1 text-xs text-muted-foreground"
              >
                <IconCheck className="shrink-0 text-violet-500 mt-px" />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
