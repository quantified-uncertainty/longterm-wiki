/**
 * Batch Quality Report
 *
 * Captures pre/post metrics for each page in a batch run and generates
 * a quality report with per-page deltas, summary stats, and degradation flags.
 *
 * See issue #824.
 */

import fs from 'fs';
import path from 'path';

import { extractMetrics, type ContentMetrics, type ContentFormat } from '../lib/metrics-extractor.ts';
import { parseFrontmatter } from '../lib/mdx-utils.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Snapshot of quality-relevant metrics for a single page at a point in time. */
export interface PageQualitySnapshot {
  wordCount: number;
  sectionCount: number;
  footnoteCount: number;
  tableCount: number;
  diagramCount: number;
  entityLinkCount: number;
  externalLinks: number;
  structuralScore: number;
  /** Quality grade from frontmatter (0-100), null if not set. */
  qualityGrade: number | null;
  /** Reader importance from frontmatter (1-5), null if not set. */
  readerImportance: number | null;
}

/** Per-page quality delta (post minus pre). */
export interface PageQualityDelta {
  pageId: string;
  before: PageQualitySnapshot;
  after: PageQualitySnapshot;
  delta: {
    wordCount: number;
    sectionCount: number;
    footnoteCount: number;
    tableCount: number;
    diagramCount: number;
    entityLinkCount: number;
    externalLinks: number;
    structuralScore: number;
    qualityGrade: number | null;
  };
  /** Whether this page was flagged as degraded. */
  degraded: boolean;
  /** Reasons for degradation flag (empty if not degraded). */
  degradationReasons: string[];
}

/** Summary statistics across the entire batch. */
export interface BatchQualitySummary {
  totalPages: number;
  pagesImproved: number;
  pagesUnchanged: number;
  pagesDegraded: number;
  averageWordCountChange: number;
  totalNewCitations: number;
  totalNewTables: number;
  totalNewDiagrams: number;
  averageStructuralScoreChange: number;
  /** Pages that had quality grade changes. */
  gradeChanges: {
    improved: number;
    unchanged: number;
    degraded: number;
  };
}

/** Full batch quality report. */
export interface BatchQualityReport {
  generatedAt: string;
  tier: string;
  totalCost: number;
  totalDuration: string;
  summary: BatchQualitySummary;
  pages: PageQualityDelta[];
  /** Pages flagged for manual review (degraded). */
  flaggedForReview: string[];
}

// ---------------------------------------------------------------------------
// Metric snapshot extraction
// ---------------------------------------------------------------------------

/**
 * Extract a quality snapshot from an MDX file on disk.
 * Returns null if the file doesn't exist.
 */
export function snapshotFromFile(filePath: string): PageQualitySnapshot | null {
  if (!fs.existsSync(filePath)) return null;

  const content = fs.readFileSync(filePath, 'utf-8');
  return snapshotFromContent(content);
}

/**
 * Extract a quality snapshot from raw MDX content.
 */
export function snapshotFromContent(content: string): PageQualitySnapshot {
  const frontmatter = parseFrontmatter(content);
  const contentFormat = (typeof frontmatter.contentFormat === 'string' ? frontmatter.contentFormat : 'article') as ContentFormat;
  const metrics: ContentMetrics = extractMetrics(content, '', contentFormat);

  return {
    wordCount: metrics.wordCount,
    sectionCount: metrics.sectionCount.h2,
    footnoteCount: metrics.footnoteCount,
    tableCount: metrics.tableCount,
    diagramCount: metrics.diagramCount,
    entityLinkCount: metrics.internalLinks,
    externalLinks: metrics.externalLinks,
    structuralScore: metrics.structuralScoreNormalized,
    qualityGrade: typeof frontmatter.quality === 'number' ? frontmatter.quality : null,
    readerImportance: typeof frontmatter.readerImportance === 'number' ? frontmatter.readerImportance : null,
  };
}

// ---------------------------------------------------------------------------
// Delta computation
// ---------------------------------------------------------------------------

/** Degradation thresholds — pages that cross these are flagged for review. */
const DEGRADATION_THRESHOLDS = {
  /** Word count dropped by more than this fraction. */
  wordCountDropPct: 0.2,
  /** Structural score dropped by more than this many points (0-50 scale). */
  structuralScoreDrop: 5,
};

/**
 * Compute the quality delta between two snapshots for a page.
 */
export function computeDelta(
  pageId: string,
  before: PageQualitySnapshot,
  after: PageQualitySnapshot,
): PageQualityDelta {
  const delta = {
    wordCount: after.wordCount - before.wordCount,
    sectionCount: after.sectionCount - before.sectionCount,
    footnoteCount: after.footnoteCount - before.footnoteCount,
    tableCount: after.tableCount - before.tableCount,
    diagramCount: after.diagramCount - before.diagramCount,
    entityLinkCount: after.entityLinkCount - before.entityLinkCount,
    externalLinks: after.externalLinks - before.externalLinks,
    structuralScore: after.structuralScore - before.structuralScore,
    qualityGrade:
      before.qualityGrade != null && after.qualityGrade != null
        ? after.qualityGrade - before.qualityGrade
        : null,
  };

  // Check for degradation
  const degradationReasons: string[] = [];

  // Word count dropped significantly
  if (
    before.wordCount > 0 &&
    delta.wordCount < 0 &&
    Math.abs(delta.wordCount) / before.wordCount > DEGRADATION_THRESHOLDS.wordCountDropPct
  ) {
    const pct = Math.round((Math.abs(delta.wordCount) / before.wordCount) * 100);
    degradationReasons.push(`Word count dropped ${pct}% (${before.wordCount} → ${after.wordCount})`);
  }

  // Citations decreased
  if (delta.footnoteCount < 0) {
    degradationReasons.push(
      `Footnotes decreased (${before.footnoteCount} → ${after.footnoteCount})`,
    );
  }

  // Tables decreased
  if (delta.tableCount < 0) {
    degradationReasons.push(
      `Tables decreased (${before.tableCount} → ${after.tableCount})`,
    );
  }

  // Quality grade dropped
  if (delta.qualityGrade != null && delta.qualityGrade < 0) {
    degradationReasons.push(
      `Quality grade dropped (${before.qualityGrade} → ${after.qualityGrade})`,
    );
  }

  // Structural score dropped significantly
  if (delta.structuralScore < -DEGRADATION_THRESHOLDS.structuralScoreDrop) {
    degradationReasons.push(
      `Structural score dropped ${Math.abs(delta.structuralScore)} points (${before.structuralScore} → ${after.structuralScore})`,
    );
  }

  return {
    pageId,
    before,
    after,
    delta,
    degraded: degradationReasons.length > 0,
    degradationReasons,
  };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

/**
 * Classify a page delta as improved/unchanged/degraded.
 * "Improved" = structural score went up or word count grew meaningfully.
 * "Degraded" = flagged by degradation checks.
 * "Unchanged" = everything else.
 */
function classifyChange(d: PageQualityDelta): 'improved' | 'unchanged' | 'degraded' {
  if (d.degraded) return 'degraded';
  if (d.delta.structuralScore > 0 || d.delta.wordCount > 50 || d.delta.footnoteCount > 0) {
    return 'improved';
  }
  return 'unchanged';
}

/**
 * Generate the full batch quality report from per-page deltas.
 */
export function generateQualityReport(
  deltas: PageQualityDelta[],
  meta: { tier: string; totalCost: number; totalDuration: string },
): BatchQualityReport {
  const improved = deltas.filter((d) => classifyChange(d) === 'improved');
  const unchanged = deltas.filter((d) => classifyChange(d) === 'unchanged');
  const degraded = deltas.filter((d) => classifyChange(d) === 'degraded');

  const totalWordCountChange = deltas.reduce((sum, d) => sum + d.delta.wordCount, 0);
  const totalFootnoteChange = deltas.reduce((sum, d) => sum + Math.max(0, d.delta.footnoteCount), 0);
  const totalTableChange = deltas.reduce((sum, d) => sum + Math.max(0, d.delta.tableCount), 0);
  const totalDiagramChange = deltas.reduce((sum, d) => sum + Math.max(0, d.delta.diagramCount), 0);
  const totalStructuralChange = deltas.reduce((sum, d) => sum + d.delta.structuralScore, 0);

  // Grade changes (only for pages where both before and after have grades)
  const withGrades = deltas.filter((d) => d.delta.qualityGrade != null);
  const gradeImproved = withGrades.filter((d) => d.delta.qualityGrade! > 0).length;
  const gradeUnchanged = withGrades.filter((d) => d.delta.qualityGrade === 0).length;
  const gradeDegraded = withGrades.filter((d) => d.delta.qualityGrade! < 0).length;

  return {
    generatedAt: new Date().toISOString(),
    tier: meta.tier,
    totalCost: meta.totalCost,
    totalDuration: meta.totalDuration,
    summary: {
      totalPages: deltas.length,
      pagesImproved: improved.length,
      pagesUnchanged: unchanged.length,
      pagesDegraded: degraded.length,
      averageWordCountChange: deltas.length > 0 ? Math.round(totalWordCountChange / deltas.length) : 0,
      totalNewCitations: totalFootnoteChange,
      totalNewTables: totalTableChange,
      totalNewDiagrams: totalDiagramChange,
      averageStructuralScoreChange:
        deltas.length > 0
          ? Math.round((totalStructuralChange / deltas.length) * 10) / 10
          : 0,
      gradeChanges: {
        improved: gradeImproved,
        unchanged: gradeUnchanged,
        degraded: gradeDegraded,
      },
    },
    pages: deltas,
    flaggedForReview: degraded.map((d) => d.pageId),
  };
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

/**
 * Write the quality report as JSON.
 */
export function writeJsonReport(report: BatchQualityReport, outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
}

/**
 * Format the quality report as human-readable markdown.
 */
export function formatMarkdownReport(report: BatchQualityReport): string {
  const lines: string[] = [];
  const { summary } = report;

  lines.push('# Batch Quality Report');
  lines.push('');
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Tier:** ${report.tier}`);
  lines.push(`**Total Cost:** $${report.totalCost.toFixed(2)}`);
  lines.push(`**Duration:** ${report.totalDuration}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total pages | ${summary.totalPages} |`);
  lines.push(`| Improved | ${summary.pagesImproved} |`);
  lines.push(`| Unchanged | ${summary.pagesUnchanged} |`);
  lines.push(`| Degraded | ${summary.pagesDegraded} |`);
  lines.push(`| Avg word count change | ${summary.averageWordCountChange > 0 ? '+' : ''}${summary.averageWordCountChange} |`);
  lines.push(`| New citations added | +${summary.totalNewCitations} |`);
  lines.push(`| New tables added | +${summary.totalNewTables} |`);
  lines.push(`| New diagrams added | +${summary.totalNewDiagrams} |`);
  lines.push(`| Avg structural score change | ${summary.averageStructuralScoreChange > 0 ? '+' : ''}${summary.averageStructuralScoreChange} |`);
  if (summary.gradeChanges.improved + summary.gradeChanges.unchanged + summary.gradeChanges.degraded > 0) {
    lines.push(`| Grade improved | ${summary.gradeChanges.improved} |`);
    lines.push(`| Grade unchanged | ${summary.gradeChanges.unchanged} |`);
    lines.push(`| Grade degraded | ${summary.gradeChanges.degraded} |`);
  }
  lines.push('');

  // Per-page details
  lines.push('## Per-Page Results');
  lines.push('');
  lines.push('| Page | Words | Sections | Citations | Tables | Structural | Grade | Status |');
  lines.push('|------|-------|----------|-----------|--------|------------|-------|--------|');

  for (const d of report.pages) {
    const status = classifyChange(d);
    const fmtDelta = (n: number) => (n > 0 ? `+${n}` : `${n}`);
    const gradeDelta =
      d.delta.qualityGrade != null ? fmtDelta(d.delta.qualityGrade) : 'n/a';

    lines.push(
      `| ${d.pageId} | ${fmtDelta(d.delta.wordCount)} | ${fmtDelta(d.delta.sectionCount)} | ${fmtDelta(d.delta.footnoteCount)} | ${fmtDelta(d.delta.tableCount)} | ${fmtDelta(d.delta.structuralScore)} | ${gradeDelta} | ${status} |`,
    );
  }
  lines.push('');

  // Flagged pages
  if (report.flaggedForReview.length > 0) {
    lines.push('## Flagged for Manual Review');
    lines.push('');
    for (const d of report.pages.filter((p) => p.degraded)) {
      lines.push(`### ${d.pageId}`);
      for (const reason of d.degradationReasons) {
        lines.push(`- ${reason}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
