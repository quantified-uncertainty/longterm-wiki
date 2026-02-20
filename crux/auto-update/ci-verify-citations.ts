/**
 * CI Citation Verification for Auto-Update Pages
 *
 * Verifies all citation URLs for a set of pages and produces a structured
 * summary for CI/PR use. Calls the citation archive library directly
 * instead of shelling out to CLI commands and parsing JSON with jq.
 *
 * SQLite note: verifyCitationsForPage stores full HTML content in SQLite
 * as a best-effort cache. Works fine when SQLite is unavailable — metadata
 * is always saved to YAML in data/citation-archive/.
 *
 * Usage (via crux CLI):
 *   pnpm crux auto-update verify-citations <page-id> [page-id...]
 *   pnpm crux auto-update verify-citations --from-report=<path>
 *   pnpm crux auto-update verify-citations --json
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import {
  verifyCitationsForPage,
  extractCitationsFromContent,
} from '../lib/citation-archive.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PageCitationResult {
  pageId: string;
  totalCitations: number;
  verified: number;
  broken: number;
  unverifiable: number;
  brokenUrls: Array<{ url: string; httpStatus: number | null }>;
}

export interface CitationVerificationResult {
  pages: PageCitationResult[];
  totalVerified: number;
  totalBroken: number;
  hasBroken: boolean;
  markdownSummary: string;
}

// ── Page ID extraction from run report ───────────────────────────────────────

export function extractPageIdsFromReport(reportPath: string): string[] {
  if (!existsSync(reportPath)) return [];

  try {
    const content = readFileSync(reportPath, 'utf-8');
    const report = parseYaml(content);

    if (!report?.execution?.pages || !Array.isArray(report.execution.pages)) {
      return [];
    }

    return report.execution.pages
      .filter((p: { status?: string }) => p.status === 'success')
      .map((p: { pageId?: string }) => p.pageId)
      .filter((id: unknown): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/** Find the most recent run report for a given date */
export function findRunReport(date: string): string | null {
  const runsDir = join(PROJECT_ROOT, 'data/auto-update/runs');
  if (!existsSync(runsDir)) return null;

  try {
    const files = readdirSync(runsDir) as string[];
    const matching = files
      .filter((f: string) => f.startsWith(date) && f.endsWith('.yaml') && !f.includes('-details'))
      .sort()
      .reverse();
    return matching.length > 0 ? join(runsDir, matching[0]) : null;
  } catch {
    return null;
  }
}

// ── Single page verification ─────────────────────────────────────────────────

async function verifyPage(pageId: string): Promise<PageCitationResult> {
  const filePath = findPageFile(pageId);
  if (!filePath) {
    return { pageId, totalCitations: 0, verified: 0, broken: 0, unverifiable: 0, brokenUrls: [] };
  }

  const raw = readFileSync(filePath, 'utf-8');
  const body = stripFrontmatter(raw);
  const citations = extractCitationsFromContent(body);

  if (citations.length === 0) {
    return { pageId, totalCitations: 0, verified: 0, broken: 0, unverifiable: 0, brokenUrls: [] };
  }

  const archive = await verifyCitationsForPage(pageId, body, { verbose: false });

  return {
    pageId,
    totalCitations: archive.totalCitations,
    verified: archive.verified,
    broken: archive.broken,
    unverifiable: archive.unverifiable,
    brokenUrls: archive.citations
      .filter(c => c.status === 'broken')
      .map(c => ({ url: c.url, httpStatus: c.httpStatus })),
  };
}

// ── Markdown summary ─────────────────────────────────────────────────────────

export function buildCitationSummary(pages: PageCitationResult[]): string {
  if (pages.length === 0) return 'No pages to verify.';

  const lines: string[] = [];

  lines.push('| Page | Total | Verified | Broken |');
  lines.push('|------|-------|----------|--------|');

  for (const p of pages) {
    const brokenCell = p.broken > 0 ? `**${p.broken}**` : String(p.broken);
    lines.push(`| \`${p.pageId}\` | ${p.totalCitations} | ${p.verified} | ${brokenCell} |`);
  }

  const totalVerified = pages.reduce((s, p) => s + p.verified, 0);
  const totalBroken = pages.reduce((s, p) => s + p.broken, 0);
  lines.push('');
  lines.push(`**Totals:** ${totalVerified} verified, ${totalBroken} broken`);

  const brokenPages = pages.filter(p => p.broken > 0);
  if (brokenPages.length > 0) {
    lines.push('');
    lines.push('<details><summary>Broken citation details</summary>');
    lines.push('');
    for (const p of brokenPages) {
      lines.push(`**${p.pageId}** broken URLs:`);
      for (const b of p.brokenUrls) {
        lines.push(`- ${b.url} (HTTP ${b.httpStatus || 'error'})`);
      }
      lines.push('');
    }
    lines.push('</details>');
    lines.push('');
    lines.push('> Warning: Broken citations detected — reviewer should check these pages carefully.');
  }

  return lines.join('\n');
}

// ── Main pipeline ────────────────────────────────────────────────────────────

export async function verifyCitationsForPages(
  pageIds: string[],
): Promise<CitationVerificationResult> {
  const pages: PageCitationResult[] = [];

  for (let i = 0; i < pageIds.length; i++) {
    const pageId = pageIds[i];
    console.log(`[${i + 1}/${pageIds.length}] Verifying citations: ${pageId}`);
    const result = await verifyPage(pageId);
    pages.push(result);

    if (result.broken > 0) {
      console.log(`  ${result.broken} broken citation(s)`);
    } else if (result.totalCitations > 0) {
      console.log(`  ${result.verified} verified`);
    } else {
      console.log(`  No citations`);
    }
  }

  const totalVerified = pages.reduce((s, p) => s + p.verified, 0);
  const totalBroken = pages.reduce((s, p) => s + p.broken, 0);

  return {
    pages,
    totalVerified,
    totalBroken,
    hasBroken: totalBroken > 0,
    markdownSummary: buildCitationSummary(pages),
  };
}
