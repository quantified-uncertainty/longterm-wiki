/**
 * Page Coverage Scorer
 *
 * Pure computation module (no React, no Node APIs). Computes coverage scores
 * for wiki pages based on their structural completeness — boolean items
 * (has summary, entity, schedule, etc.) and numeric metrics (tables, diagrams,
 * links, citations).
 *
 * Used by:
 *   - Build-time pipeline (build-data.mjs) → stored in database.json per page
 *   - PageStatus component (reads pre-computed coverage, overrides live citation data)
 *   - Page Coverage dashboard (/internal/page-coverage)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CoverageStatus = 'green' | 'amber' | 'red';

export interface CoverageTargets {
  tables: number;
  diagrams: number;
  internalLinks: number;
  externalLinks: number;
  footnotes: number;
  references: number;
}

export interface CoverageActuals {
  tables: number;
  diagrams: number;
  internalLinks: number;
  externalLinks: number;
  footnotes: number;
  references: number;
  quotesWithQuotes: number;
  quotesTotal: number;
  accuracyChecked: number;
  accuracyTotal: number;
}

export interface PageCoverage {
  /** Number of items with 'green' status */
  passing: number;
  /** Total scored items (5 boolean + 8 numeric = 13) */
  total: number;
  /** Recommended targets based on wordCount + contentFormat */
  targets: CoverageTargets;
  /** Actual metric counts */
  actuals: CoverageActuals;
  /** Per-item status keyed by item name */
  items: Record<string, CoverageStatus>;
  /** Number of edit history entries */
  editHistoryCount?: number;
  /** Compact ratings string e.g. "N:8 R:7 A:6 C:9" */
  ratingsString?: string;
  /** Number of canonical facts for this entity */
  factCount?: number;
}

export interface CoverageInput {
  wordCount: number;
  contentFormat: string;
  llmSummary?: string | null;
  updateFrequency?: number | null;
  hasEntity: boolean;
  changeHistoryCount: number;
  tableCount: number;
  diagramCount: number;
  internalLinks: number;
  externalLinks: number;
  footnoteCount: number;
  resourceCount: number;
  quotesWithQuotes: number;
  quotesTotal: number;
  accuracyChecked: number;
  accuracyTotal: number;
  ratings?: {
    novelty?: number;
    rigor?: number;
    actionability?: number;
    completeness?: number;
  } | null;
  factCount?: number;
}

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

/**
 * Compute recommended metric targets based on word count and content format.
 * Calibrated against high-quality pages (quality >= 70):
 * tables ~4.4/kw, diagrams ~0.4/kw, intLinks ~9.8/kw, footnotes ~3.3/kw
 */
export function getRecommendedTargets(
  wordCount: number,
  contentFormat: string,
): CoverageTargets {
  const kWords = wordCount / 1000;

  if (contentFormat === 'table') {
    return {
      tables: Math.max(2, Math.round(kWords * 5)),
      diagrams: Math.max(0, Math.round(kWords * 0.3)),
      internalLinks: Math.max(3, Math.round(kWords * 5)),
      externalLinks: Math.max(1, Math.round(kWords * 3)),
      footnotes: Math.max(1, Math.round(kWords * 2)),
      references: Math.max(1, Math.round(kWords * 2)),
    };
  }
  if (contentFormat === 'diagram') {
    return {
      tables: Math.max(0, Math.round(kWords * 1)),
      diagrams: Math.max(1, Math.round(kWords * 1)),
      internalLinks: Math.max(3, Math.round(kWords * 5)),
      externalLinks: Math.max(1, Math.round(kWords * 3)),
      footnotes: Math.max(1, Math.round(kWords * 2)),
      references: Math.max(1, Math.round(kWords * 2)),
    };
  }
  if (contentFormat === 'index' || contentFormat === 'dashboard') {
    return {
      tables: Math.max(0, Math.round(kWords * 1)),
      diagrams: 0,
      internalLinks: Math.max(5, Math.round(kWords * 8)),
      externalLinks: Math.max(0, Math.round(kWords * 2)),
      footnotes: 0,
      references: Math.max(0, Math.round(kWords * 1)),
    };
  }

  // Default: article format
  return {
    tables: Math.max(1, Math.round(kWords * 4)),
    diagrams: Math.max(0, Math.round(kWords * 0.4)),
    internalLinks: Math.max(3, Math.round(kWords * 8)),
    externalLinks: Math.max(1, Math.round(kWords * 5)),
    footnotes: Math.max(2, Math.round(kWords * 3)),
    references: Math.max(1, Math.round(kWords * 3)),
  };
}

/** Status for a numeric metric vs. its target */
export function getMetricStatus(
  actual: number,
  target?: number,
): CoverageStatus {
  if (target === undefined || target === 0) {
    return actual > 0 ? 'green' : 'red';
  }
  if (actual >= target) return 'green';
  if (actual > 0) return 'amber';
  return 'red';
}

/** Status for a ratio metric (e.g., quotes verified / total citations) */
export function getRatioStatus(
  numerator: number,
  denominator: number,
): CoverageStatus {
  if (denominator === 0) return 'red';
  const pct = numerator / denominator;
  if (pct >= 0.75) return 'green';
  if (numerator > 0) return 'amber';
  return 'red';
}

// ---------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------

export function computePageCoverage(input: CoverageInput): PageCoverage {
  const targets = getRecommendedTargets(input.wordCount, input.contentFormat);

  const items: Record<string, CoverageStatus> = {};

  // Boolean items (4)
  items.llmSummary = input.llmSummary ? 'green' : 'red';
  items.schedule = input.updateFrequency != null ? 'green' : 'red';
  items.entity = input.hasEntity ? 'green' : 'red';
  items.editHistory = input.changeHistoryCount > 0 ? 'green' : 'red';

  // Numeric metrics (6 target-based)
  items.tables = getMetricStatus(input.tableCount, targets.tables);
  items.diagrams = getMetricStatus(input.diagramCount, targets.diagrams);
  items.internalLinks = getMetricStatus(input.internalLinks, targets.internalLinks);
  items.externalLinks = getMetricStatus(input.externalLinks, targets.externalLinks);
  items.footnotes = getMetricStatus(input.footnoteCount, targets.footnotes);
  items.references = getMetricStatus(input.resourceCount, targets.references);

  // Ratio metrics (2)
  items.quotes = getRatioStatus(input.quotesWithQuotes, input.quotesTotal);
  items.accuracy = getRatioStatus(input.accuracyChecked, input.accuracyTotal);

  const passing = Object.values(items).filter((s) => s === 'green').length;
  const total = Object.keys(items).length; // 13

  // Build compact ratings string
  let ratingsString: string | undefined;
  if (input.ratings) {
    const parts: string[] = [];
    if (input.ratings.novelty != null) parts.push(`N:${input.ratings.novelty}`);
    if (input.ratings.rigor != null) parts.push(`R:${input.ratings.rigor}`);
    if (input.ratings.actionability != null) parts.push(`A:${input.ratings.actionability}`);
    if (input.ratings.completeness != null) parts.push(`C:${input.ratings.completeness}`);
    if (parts.length > 0) ratingsString = parts.join(' ');
  }

  return {
    passing,
    total,
    targets,
    actuals: {
      tables: input.tableCount,
      diagrams: input.diagramCount,
      internalLinks: input.internalLinks,
      externalLinks: input.externalLinks,
      footnotes: input.footnoteCount,
      references: input.resourceCount,
      quotesWithQuotes: input.quotesWithQuotes,
      quotesTotal: input.quotesTotal,
      accuracyChecked: input.accuracyChecked,
      accuracyTotal: input.accuracyTotal,
    },
    items,
    editHistoryCount: input.changeHistoryCount || undefined,
    ratingsString,
    factCount: input.factCount || undefined,
  };
}
