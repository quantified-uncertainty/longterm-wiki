/**
 * CI Hallucination Risk Scores for Auto-Update Pages
 *
 * Computes hallucination risk scores for specific pages and produces a
 * structured summary for CI/PR use. Reuses the scoring logic from
 * validate-hallucination-risk.ts instead of shelling out and parsing JSON.
 *
 * SQLite note: uses loadAccuracyMap() which gracefully returns null when
 * the knowledge.db file doesn't exist (e.g., in GitHub Actions).
 *
 * Usage (via crux CLI):
 *   pnpm crux auto-update risk-scores <page-id> [page-id...]
 *   pnpm crux auto-update risk-scores --json
 */

import { findPageFile } from '../lib/file-utils.ts';
import {
  assessPage,
  loadAccuracyMap,
  type RiskAssessment,
} from '../validate/validate-hallucination-risk.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PageRiskResult {
  pageId: string;
  riskScore: number;
  riskLevel: 'high' | 'medium' | 'low' | 'unknown';
  totalCitations: number;
  riskFactors: string[];
}

export interface RiskScoresResult {
  pages: PageRiskResult[];
  hasHighRisk: boolean;
  markdownSummary: string;
}

// ── Markdown summary ─────────────────────────────────────────────────────────

export function buildRiskSummary(pages: PageRiskResult[]): string {
  if (pages.length === 0) return 'No pages to assess.';

  const lines: string[] = [];

  lines.push('| Page | Score | Level | Citations | Risk Factors |');
  lines.push('|------|-------|-------|-----------|--------------|');

  for (const p of pages) {
    const scoreCell = p.riskLevel === 'high' || p.riskLevel === 'medium'
      ? `**${p.riskScore}**` : String(p.riskScore);
    const factors = p.riskFactors.length > 0 ? p.riskFactors.join(', ') : '-';
    lines.push(`| \`${p.pageId}\` | ${scoreCell} | ${p.riskLevel} | ${p.totalCitations} | ${factors} |`);
  }

  const hasHighRisk = pages.some(p => p.riskLevel === 'high');
  if (hasHighRisk) {
    lines.push('');
    lines.push('> **High-risk pages detected** — these pages need careful human review before merging.');
  }

  return lines.join('\n');
}

// ── Main pipeline ────────────────────────────────────────────────────────────

export function computeRiskScores(pageIds: string[]): RiskScoresResult {
  // Load accuracy data from SQLite if available (null if DB doesn't exist)
  const accuracyMap = loadAccuracyMap();

  const pages: PageRiskResult[] = [];

  for (const pageId of pageIds) {
    const filePath = findPageFile(pageId);
    if (!filePath) {
      pages.push({
        pageId,
        riskScore: 0,
        riskLevel: 'unknown',
        totalCitations: 0,
        riskFactors: [],
      });
      continue;
    }

    try {
      const assessment = assessPage(filePath, accuracyMap);
      if (assessment) {
        pages.push({
          pageId: assessment.pageId,
          riskScore: assessment.riskScore,
          riskLevel: assessment.riskLevel,
          totalCitations: assessment.totalCitations,
          riskFactors: assessment.riskFactors,
        });
      } else {
        // assessPage returns null for stubs, short pages, non-knowledge-base pages
        pages.push({
          pageId,
          riskScore: 0,
          riskLevel: 'low',
          totalCitations: 0,
          riskFactors: [],
        });
      }
    } catch {
      pages.push({
        pageId,
        riskScore: 0,
        riskLevel: 'unknown',
        totalCitations: 0,
        riskFactors: [],
      });
    }
  }

  return {
    pages,
    hasHighRisk: pages.some(p => p.riskLevel === 'high'),
    markdownSummary: buildRiskSummary(pages),
  };
}
