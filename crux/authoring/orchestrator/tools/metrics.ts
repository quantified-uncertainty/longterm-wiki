/**
 * Quality metrics extraction for the orchestrator.
 *
 * Shared between tool handlers (get_page_metrics) and quality-gate.ts.
 * Extracted to its own module to avoid circular imports.
 */

import { extractMetrics } from '../../../lib/metrics-extractor.ts';
import type { QualityMetrics } from '../types.ts';

/** Extract quality metrics from a content string. */
export function extractQualityMetrics(content: string, filePath: string): QualityMetrics {
  const metrics = extractMetrics(content, filePath);
  return {
    wordCount: metrics.wordCount,
    footnoteCount: metrics.footnoteCount,
    entityLinkCount: metrics.internalLinks,
    diagramCount: metrics.diagramCount,
    tableCount: metrics.tableCount,
    sectionCount: metrics.sectionCount.h2,
    structuralScore: metrics.structuralScoreNormalized,
  };
}
