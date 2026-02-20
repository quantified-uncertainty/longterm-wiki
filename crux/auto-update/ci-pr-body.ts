/**
 * CI PR Body Builder for Auto-Update PRs
 *
 * Constructs the PR body from run report data and optional citation/risk
 * summaries. Replaces the complex shell heredoc construction in the
 * auto-update workflow.
 *
 * Usage (via crux CLI):
 *   pnpm crux auto-update pr-body --report=<path> [--citations=<markdown>] [--risk=<markdown>]
 */

import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { RunReport } from './types.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PrBodyOptions {
  reportPath: string | null;
  date: string;
  citationSummary?: string;
  riskSummary?: string;
}

// ── Report parsing ───────────────────────────────────────────────────────────

export function readRunReport(reportPath: string): { pagesUpdated: number; budgetSpent: number } {
  if (!existsSync(reportPath)) {
    return { pagesUpdated: 0, budgetSpent: 0 };
  }

  try {
    const content = readFileSync(reportPath, 'utf-8');
    const report = parseYaml(content) as RunReport;
    return {
      pagesUpdated: report?.execution?.pagesUpdated ?? 0,
      budgetSpent: report?.budget?.spent ?? 0,
    };
  } catch {
    return { pagesUpdated: 0, budgetSpent: 0 };
  }
}

// ── PR body construction ─────────────────────────────────────────────────────

export function buildPrBody(options: PrBodyOptions): string {
  const { reportPath, date, citationSummary, riskSummary } = options;

  const report = reportPath ? readRunReport(reportPath) : { pagesUpdated: 0, budgetSpent: 0 };

  const sections: string[] = [];

  // Header
  sections.push(`## Auto-Update Run — ${date}`);
  sections.push('');
  sections.push('Automated news-driven wiki update.');
  sections.push('');
  sections.push(`- **Pages updated:** ${report.pagesUpdated}`);
  sections.push(`- **Budget spent:** \\$${report.budgetSpent}`);
  sections.push('');

  // Run report reference
  sections.push('### Run Report');
  sections.push(`See \`${reportPath || 'data/auto-update/runs/'}\` for full details.`);
  sections.push('');

  // Risk scores (before citations — higher-level concern)
  if (riskSummary) {
    sections.push('### Hallucination Risk Scores');
    sections.push('');
    sections.push(riskSummary);
    sections.push('');
  }

  // Citation verification
  if (citationSummary) {
    sections.push('### Citation Verification');
    sections.push('');
    sections.push(citationSummary);
    sections.push('');
  }

  // Audit gate info
  sections.push('### Automated Review');
  sections.push('');
  sections.push('The **citation audit gate** will automatically:');
  sections.push('1. Extract and verify citations on all changed pages');
  sections.push('2. Check claim accuracy against source material');
  sections.push('3. Auto-fix inaccurate citations where possible');
  sections.push('4. Report remaining issues');
  sections.push('');
  sections.push('The audit gate CI check will pass if no inaccurate citations remain.');
  sections.push('');
  sections.push('---');
  sections.push('*This PR was created automatically by the auto-update workflow.*');

  return sections.join('\n');
}
