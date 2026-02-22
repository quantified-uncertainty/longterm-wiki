/**
 * Quality Gate for the Agent Orchestrator
 *
 * After the orchestrator finishes its tool-calling loop, the quality gate
 * evaluates the improved content against structural metrics and produces
 * a pass/fail + gap summary. If it fails, the gap summary is fed back
 * to the orchestrator for a refinement cycle (max 2).
 *
 * See E766 Part 11 and issue #692.
 */

import type { OrchestratorContext, QualityMetrics, QualityGateResult, OrchestratorTier } from './types.ts';
import { extractQualityMetrics } from './tools.ts';

// ---------------------------------------------------------------------------
// Quality thresholds per tier
// ---------------------------------------------------------------------------

/**
 * Minimum expected metrics per tier.
 *
 * These are NOT hard gates — the gate produces a gap summary rather than
 * a binary pass/fail. But pages significantly below these thresholds will
 * trigger a refinement cycle.
 */
interface QualityThresholds {
  /** Min word count below which page feels thin. */
  minWordCount: number;
  /** Min citation count (footnote references). */
  minFootnotes: number;
  /** Min EntityLink count (internal cross-references). */
  minEntityLinks: number;
  /** Min structural score (0-100). */
  minStructuralScore: number;
}

const TIER_THRESHOLDS: Record<OrchestratorTier, QualityThresholds> = {
  polish: {
    minWordCount: 500,
    minFootnotes: 3,
    minEntityLinks: 3,
    minStructuralScore: 30,
  },
  standard: {
    minWordCount: 800,
    minFootnotes: 8,
    minEntityLinks: 5,
    minStructuralScore: 40,
  },
  deep: {
    minWordCount: 1200,
    minFootnotes: 15,
    minEntityLinks: 10,
    minStructuralScore: 55,
  },
};

// ---------------------------------------------------------------------------
// Quality gate evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the quality gate for the current orchestrator state.
 *
 * Compares the improved content's metrics against tier-specific thresholds
 * and the original content's metrics (regression detection).
 */
export function evaluateQualityGate(ctx: OrchestratorContext): QualityGateResult {
  const metrics = extractQualityMetrics(ctx.currentContent, ctx.filePath);
  const originalMetrics = extractQualityMetrics(ctx.originalContent, ctx.filePath);
  const thresholds = TIER_THRESHOLDS[ctx.budget.name.toLowerCase() as OrchestratorTier]
    || TIER_THRESHOLDS.standard;

  const gaps: string[] = [];

  // Check for regressions (content got worse)
  if (metrics.wordCount < originalMetrics.wordCount * 0.7) {
    gaps.push(
      `Word count dropped significantly: ${originalMetrics.wordCount} → ${metrics.wordCount} ` +
      `(${Math.round((1 - metrics.wordCount / originalMetrics.wordCount) * 100)}% decrease). ` +
      `The page should not lose substantial content during improvement.`
    );
  }

  if (metrics.footnoteCount < originalMetrics.footnoteCount * 0.8) {
    gaps.push(
      `Citation count dropped: ${originalMetrics.footnoteCount} → ${metrics.footnoteCount}. ` +
      `Improvements should not remove existing citations.`
    );
  }

  if (originalMetrics.tableCount > 0 && metrics.tableCount < originalMetrics.tableCount) {
    gaps.push(
      `Table count dropped: ${originalMetrics.tableCount} → ${metrics.tableCount}. ` +
      `Tables provide structural value — preserve or improve them, don't remove them.`
    );
  }

  // Check against tier thresholds
  if (metrics.wordCount < thresholds.minWordCount) {
    gaps.push(
      `Word count (${metrics.wordCount}) is below the ${thresholds.minWordCount} minimum for ${ctx.budget.name} tier. ` +
      `Consider expanding thin sections.`
    );
  }

  // Only check absolute footnote threshold if research is available.
  // For polish tier (0 research queries), we can't add new citations,
  // so only check for regression (handled above).
  if (ctx.budget.maxResearchQueries > 0 && metrics.footnoteCount < thresholds.minFootnotes) {
    gaps.push(
      `Citation count (${metrics.footnoteCount}) is below the ${thresholds.minFootnotes} minimum for ${ctx.budget.name} tier. ` +
      `Run research and rewrite sections that lack citations.`
    );
  }

  if (metrics.entityLinkCount < thresholds.minEntityLinks) {
    gaps.push(
      `EntityLink count (${metrics.entityLinkCount}) is below the ${thresholds.minEntityLinks} minimum. ` +
      `Run add_entity_links to insert cross-references.`
    );
  }

  if (metrics.structuralScore < thresholds.minStructuralScore) {
    gaps.push(
      `Structural score (${metrics.structuralScore}) is below the ${thresholds.minStructuralScore} threshold. ` +
      `Improve section structure, add tables or diagrams where appropriate.`
    );
  }

  // Check for improvement (must have actually changed something)
  const contentUnchanged = ctx.currentContent === ctx.originalContent;
  if (contentUnchanged) {
    gaps.push('No changes were made to the page. The orchestrator should have improved at least some sections.');
  }

  const passed = gaps.length === 0;
  const gapSummary = passed
    ? 'All quality checks passed.'
    : gaps.map((g, i) => `${i + 1}. ${g}`).join('\n');

  return { passed, metrics, gapSummary, gaps };
}
