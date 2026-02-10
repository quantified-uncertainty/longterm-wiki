import Link from "next/link";
import { cn } from "@lib/utils";
import {
  detectPageType,
  PAGE_TYPE_INFO,
} from "@/lib/page-types";
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

export interface PageStatusProps {
  quality?: number;
  importance?: number;
  llmSummary?: string;
  lastEdited?: string;
  updateFrequency?: number;
  todo?: string;
  todos?: string[];
  wordCount?: number;
  backlinkCount?: number;
  metrics?: PageMetrics;
  suggestedQuality?: number;
  issues?: PageIssues;
  pageType?: string;
  pathname?: string;
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

function formatWordCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}

function formatAge(lastEdited: string): string {
  const today = new Date();
  const edited = new Date(lastEdited);
  const days = Math.floor(
    (today.getTime() - edited.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days <= 14) return `${days} days ago`;
  if (days <= 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

function formatFrequency(days: number): string {
  if (days <= 7) return "weekly";
  if (days <= 14) return "biweekly";
  if (days <= 21) return "every 3 weeks";
  if (days <= 30) return "monthly";
  if (days <= 45) return "every 6 weeks";
  if (days <= 60) return "bimonthly";
  if (days <= 90) return "quarterly";
  return `every ${Math.round(days / 30)} months`;
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

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

function ScoreRing({
  value,
  max,
  size = 44,
  strokeWidth = 3.5,
  color,
  children,
}: {
  value: number;
  max: number;
  size?: number;
  strokeWidth?: number;
  color: string;
  children?: React.ReactNode;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (value / max) * circumference;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90 block"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={`${progress} ${circumference - progress}`}
          strokeDashoffset={circumference / 4}
          strokeLinecap="round"
          className="transition-[stroke-dasharray] duration-500 ease-out"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center">
        {children}
      </span>
    </div>
  );
}

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
    <span className={cn(styles.wrapper, "cursor-help")}>
      <span className="inline-flex items-center gap-2">
        <ScoreRing value={quality} max={100} color={colors.ring}>
          <span className="text-[13px] font-bold tabular-nums text-foreground">
            {quality}
          </span>
        </ScoreRing>
        <span className="flex flex-col">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground leading-none">
            Quality
          </span>
          <span className={`text-[13px] font-semibold leading-snug inline-flex items-center gap-1.5 ${colors.text}`}>
            {qualityLabels[level]}
            {hasDiscrepancy && (
              <span className="inline-block size-1.5 rounded-full bg-amber-500" />
            )}
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
          Quality: {quality}/100
        </span>
        <span className="block text-muted-foreground text-xs leading-snug">
          Human-assigned rating of overall page quality, considering depth, accuracy, and completeness.
        </span>
        {hasDiscrepancy && (
          <span className="block mt-2 text-xs text-amber-500">
            Structure suggests {suggestedQuality}
          </span>
        )}
      </span>
    </span>
  );
}

function ImportanceDisplay({ importance }: { importance: number }) {
  const level = getImportanceLevel(importance);
  const colors = importanceColors[level];

  return (
    <span className={cn(styles.wrapper, "cursor-help")}>
      <span className="inline-flex items-center gap-2">
        <ScoreRing value={importance} max={100} color={colors.ring}>
          <span className="text-[13px] font-bold tabular-nums text-foreground">
            {importance}
          </span>
        </ScoreRing>
        <span className="flex flex-col">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground leading-none">
            Importance
          </span>
          <span className={`text-[13px] font-semibold leading-snug ${colors.text}`}>
            {importanceLabels[level]}
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
          Importance: {importance}/100
        </span>
        <span className="block text-muted-foreground text-xs leading-snug">
          How central this topic is to AI safety. Higher scores mean greater relevance to understanding or mitigating AI risk.
        </span>
      </span>
    </span>
  );
}

function structureItemScore(
  value: number,
  thresholds: [number, number][] // [[threshold, points], ...]
): number {
  for (const [threshold, points] of thresholds) {
    if (value >= threshold) return points;
  }
  return 0;
}

function StructureDisplay({ metrics }: { metrics: PageMetrics }) {
  const score = metrics.structuralScore;
  const scoreColor =
    score >= 10 ? "#10b981" : score >= 6 ? "#f59e0b" : "#ef4444";
  const scoreTextClass =
    score >= 10
      ? "text-emerald-500"
      : score >= 6
        ? "text-amber-500"
        : "text-red-500";

  // Reconstruct the per-item scores for the breakdown
  const breakdown = [
    { label: "Word count", max: 2, earned: structureItemScore(metrics.wordCount, [[800, 2], [300, 1]]) },
    { label: "Tables", max: 3, earned: structureItemScore(metrics.tableCount, [[3, 3], [2, 2], [1, 1]]) },
    { label: "Diagrams", max: 2, earned: structureItemScore(metrics.diagramCount, [[2, 2], [1, 1]]) },
    { label: "Internal links", max: 2, earned: structureItemScore(metrics.internalLinks, [[4, 2], [1, 1]]) },
    { label: "External citations", max: 3, earned: structureItemScore(metrics.externalLinks, [[6, 3], [3, 2], [1, 1]]) },
    { label: "Prose ratio", max: 2, earned: metrics.bulletRatio < 0.3 ? 2 : metrics.bulletRatio < 0.5 ? 1 : 0 },
    { label: "Overview section", max: 1, earned: metrics.hasOverview ? 1 : 0 },
  ];

  return (
    <span className={cn(styles.wrapper, "cursor-help")}>
      <span className="inline-flex items-center gap-2">
        <ScoreRing value={score} max={15} color={scoreColor}>
          <span className="text-[11px] font-bold tabular-nums text-foreground">
            {score}
          </span>
        </ScoreRing>
        <span className="flex flex-col">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground leading-none">
            Structure
          </span>
          <span className={`text-[13px] font-semibold leading-snug ${scoreTextClass}`}>
            {score}/15
          </span>
        </span>
      </span>
      <span
        className={cn(
          styles.tooltip,
          "absolute left-0 top-full mt-1 z-50 w-[220px] p-3 bg-popover text-popover-foreground border rounded-md shadow-md pointer-events-none opacity-0 invisible"
        )}
        role="tooltip"
      >
        <span className="block font-semibold text-foreground text-sm mb-1">
          Structure: {score}/15
        </span>
        <span className="block text-muted-foreground text-xs leading-snug mb-2">
          Automated score based on measurable content features.
        </span>
        <span className="block flex flex-col gap-0.5">
          {breakdown.map((item) => (
            <span key={item.label} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{item.label}</span>
              <span className={cn(
                "tabular-nums font-medium",
                item.earned === item.max ? "text-emerald-500" : item.earned > 0 ? "text-foreground" : "text-muted-foreground/50"
              )}>
                {item.earned}/{item.max}
              </span>
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}

function MetricChip({
  icon,
  value,
  label,
  description,
}: {
  icon: React.ReactNode;
  value: number | string;
  label: string;
  description?: string;
}) {
  return (
    <span className={cn(styles.wrapper, "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground whitespace-nowrap cursor-help")}>
      <span className="flex items-center opacity-60">{icon}</span>
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
      <span
        className={cn(
          styles.tooltip,
          "absolute right-0 top-full mt-1 z-50 w-[200px] p-2.5 bg-popover text-popover-foreground border rounded-md shadow-md pointer-events-none opacity-0 invisible"
        )}
        role="tooltip"
      >
        <span className="block font-semibold text-foreground text-xs mb-0.5">{label}</span>
        {description && (
          <span className="block text-muted-foreground text-[11px] leading-snug">{description}</span>
        )}
      </span>
    </span>
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
}: {
  issues?: PageIssues;
  metrics?: PageMetrics;
  quality?: number;
  suggestedQuality?: number;
  lastEdited?: string;
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

  if (lastEdited) {
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
    if (metrics.tableCount === 0 && metrics.diagramCount === 0) {
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

export function PageStatus({
  quality,
  importance,
  llmSummary,
  lastEdited,
  updateFrequency,
  todo,
  todos,
  wordCount,
  backlinkCount,
  metrics,
  suggestedQuality,
  issues,
  pageType,
  pathname,
}: PageStatusProps) {
  const detectedType = detectPageType(pathname || "", pageType);
  const isATMPage = detectedType === "ai-transition-model";

  const hasEditorialContent =
    quality ||
    importance ||
    llmSummary ||
    lastEdited ||
    todo ||
    (todos && todos.length > 0);
  if (!hasEditorialContent && !isATMPage) {
    return null;
  }

  const metaItems: string[] = [];
  if (lastEdited) metaItems.push(`Edited ${formatAge(lastEdited)}`);
  if (wordCount && wordCount > 0) metaItems.push(`${formatWordCount(wordCount)} words`);
  if (backlinkCount && backlinkCount > 0) metaItems.push(`${backlinkCount} backlinks`);

  const updateStatus =
    lastEdited && updateFrequency
      ? getUpdateStatus(lastEdited, updateFrequency)
      : null;

  return (
    <div className="page-status page-status-dev-only mb-6 overflow-hidden rounded-xl border border-border bg-card text-[13px] shadow-sm">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-muted px-3.5 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Page Status
          </span>
          <PageTypeBadge pageType={pageType} pathname={pathname} />
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

      {/* Score rings + metric chips */}
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-5">
          {quality !== undefined && (
            <QualityDisplay quality={quality} suggestedQuality={suggestedQuality} />
          )}
          {importance !== undefined && (
            <ImportanceDisplay importance={importance} />
          )}
          {metrics && <StructureDisplay metrics={metrics} />}
        </div>

        {metrics && (
          <div className="flex flex-wrap gap-1.5">
            <MetricChip icon={<IconTable />} value={metrics.tableCount} label="Tables" description="Data tables in the page" />
            <MetricChip icon={<IconDiagram />} value={metrics.diagramCount} label="Diagrams" description="Charts and visual diagrams" />
            <MetricChip icon={<IconLink />} value={metrics.internalLinks} label="Internal Links" description="Links to other wiki pages" />
            <MetricChip icon={<IconBook />} value={metrics.externalLinks} label="External Citations" description="References to outside sources" />
            <MetricChip
              icon={<span className="text-[10px] font-bold">%</span>}
              value={`${Math.round(metrics.bulletRatio * 100)}%`}
              label="Bullet Ratio"
              description="Percentage of content in bullet lists"
            />
          </div>
        )}
      </div>

      {/* Update Schedule */}
      {updateFrequency && (
        <div className="flex items-center gap-2 border-t border-border px-3.5 py-2 text-xs text-muted-foreground">
          <IconCalendar className="shrink-0 opacity-60" />
          <span>
            Updated{" "}
            <Link href="/wiki/updates" className="font-medium text-foreground hover:underline no-underline">
              {formatFrequency(updateFrequency)}
            </Link>
          </span>
          {updateStatus && (
            <>
              <span className="inline-block size-[3px] rounded-full bg-border" />
              <span
                className={
                  updateStatus.isOverdue
                    ? "font-medium text-amber-500"
                    : "text-muted-foreground"
                }
              >
                {updateStatus.label}
              </span>
            </>
          )}
        </div>
      )}

      {/* LLM Summary */}
      {llmSummary && (
        <div className="border-t border-border px-3.5 pt-2 pb-2.5">
          <SectionHeader>Summary</SectionHeader>
          <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">
            {llmSummary}
          </p>
        </div>
      )}

      {/* Issues */}
      <IssuesSection
        issues={issues}
        metrics={metrics}
        quality={quality}
        suggestedQuality={suggestedQuality}
        lastEdited={lastEdited}
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
