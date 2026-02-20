/**
 * CI Audit Gate for Auto-Update PRs
 *
 * Replaces the manual "reviewed" label gate with automated citation auditing.
 * Runs the full citation audit pipeline on changed pages, then evaluates
 * whether the results are acceptable for merging.
 *
 * Usage:
 *   pnpm crux auto-update audit-gate <page-id> [page-id...]   # Audit specific pages
 *   pnpm crux auto-update audit-gate --diff                    # Auto-detect from git diff
 *   pnpm crux auto-update audit-gate --diff --apply            # Audit and fix
 *   pnpm crux auto-update audit-gate --diff --json             # JSON output for CI
 *
 * Exit codes:
 *   0 — All pages pass (no inaccurate citations remain)
 *   1 — Inaccurate citations remain after audit
 *
 * Requires: OPENROUTER_API_KEY (for accuracy checks)
 * Optional: EXA_API_KEY (for source replacement search)
 */

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { basename } from 'path';
import { readFileSync } from 'fs';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { extractCitationsFromContent } from '../lib/citation-archive.ts';
import { checkAccuracyForPage } from '../citations/check-accuracy.ts';
import { exportDashboardData } from '../citations/export-dashboard.ts';
import type { AccuracyResult } from '../citations/check-accuracy.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PageAuditResult {
  pageId: string;
  totalCitations: number;
  auditRan: boolean;
  auditExitCode: number;
  finalAccuracy: AccuracyResult | null;
  error?: string;
}

export interface AuditGateResult {
  pages: PageAuditResult[];
  totalPages: number;
  pagesAudited: number;
  pagesWithIssues: number;
  totalInaccurate: number;
  totalUnsupported: number;
  passed: boolean;
  markdownSummary: string;
}

// ── Page ID extraction from git diff ─────────────────────────────────────────

function getChangedPageIds(baseBranch: string): string[] {
  try {
    const diff = execFileSync('git', [
      'diff', '--name-only',
      `origin/${baseBranch}...HEAD`,
      '--', 'content/docs/**/*.mdx',
    ], { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();

    if (!diff) return [];

    return diff
      .split('\n')
      .filter(Boolean)
      .map(filePath => basename(filePath, '.mdx'))
      .filter(id => id !== 'index'); // Skip index files
  } catch {
    return [];
  }
}

// ── Run audit subprocess ─────────────────────────────────────────────────────

function runAuditForPage(pageId: string, apply: boolean, verbose: boolean): number {
  const args = [
    '--import', 'tsx/esm', '--no-warnings',
    'crux/citations/audit.ts',
    '--', pageId,
  ];

  if (apply) args.push('--apply');

  try {
    execFileSync('node', args, {
      cwd: PROJECT_ROOT,
      timeout: 30 * 60 * 1000, // 30 min per page
      stdio: verbose ? 'inherit' : 'pipe',
      env: { ...process.env },
    });
    return 0;
  } catch (err: unknown) {
    // audit.ts exits 0 even on issues found, so exit != 0 means a real error
    const error = err as { status?: number };
    return error.status ?? 1;
  }
}

// ── Final accuracy check (reads cached results from SQLite) ──────────────────

async function getFinalAccuracy(pageId: string): Promise<AccuracyResult | null> {
  const filePath = findPageFile(pageId);
  if (!filePath) return null;

  const raw = readFileSync(filePath, 'utf-8');
  const body = stripFrontmatter(raw);
  const citations = extractCitationsFromContent(body);

  if (citations.length === 0) return null;

  // Read cached results (no LLM calls — just reads from SQLite)
  return checkAccuracyForPage(pageId, { verbose: false, recheck: false });
}

// ── Markdown summary ─────────────────────────────────────────────────────────

export function buildMarkdownSummary(results: PageAuditResult[], passed: boolean): string {
  const lines: string[] = [];

  lines.push('## Citation Audit Results\n');

  if (passed) {
    lines.push('All pages passed the citation accuracy audit.\n');
  } else {
    lines.push('> **Citation accuracy issues detected.** Some pages have inaccurate citations that could not be automatically fixed.\n');
  }

  lines.push('| Page | Citations | Accurate | Minor | Inaccurate | Unsupported | Status |');
  lines.push('|------|-----------|----------|-------|------------|-------------|--------|');

  for (const r of results) {
    if (!r.finalAccuracy) {
      if (r.totalCitations === 0) {
        lines.push(`| \`${r.pageId}\` | 0 | — | — | — | — | No citations |`);
      } else {
        lines.push(`| \`${r.pageId}\` | ${r.totalCitations} | — | — | — | — | ${r.error || 'Error'} |`);
      }
      continue;
    }

    const acc = r.finalAccuracy;
    const hasInaccurate = acc.inaccurate > 0;
    const statusIcon = hasInaccurate ? 'FAIL' : 'PASS';

    lines.push(
      `| \`${r.pageId}\` | ${acc.total} | ${acc.accurate} | ${acc.minorIssues} | `
      + `${acc.inaccurate > 0 ? `**${acc.inaccurate}**` : '0'} | `
      + `${acc.unsupported > 0 ? `**${acc.unsupported}**` : '0'} | ${statusIcon} |`,
    );
  }

  // Details for failures
  const failures = results.filter(
    r => r.finalAccuracy && r.finalAccuracy.inaccurate > 0,
  );

  if (failures.length > 0) {
    lines.push('');
    lines.push('<details><summary>Inaccurate citation details</summary>\n');

    for (const r of failures) {
      if (!r.finalAccuracy) continue;
      lines.push(`**${r.pageId}:**`);
      for (const issue of r.finalAccuracy.issues) {
        if (issue.verdict === 'inaccurate') {
          lines.push(`- [^${issue.footnote}] (score: ${issue.score.toFixed(2)}) ${issue.issues.join('; ')}`);
        }
      }
      lines.push('');
    }

    lines.push('</details>');
  }

  lines.push('');
  lines.push('---');
  lines.push('*Automated citation audit — replaces manual review gate.*');

  return lines.join('\n');
}

// ── Main pipeline ────────────────────────────────────────────────────────────

export async function runAuditGate(options: {
  pageIds?: string[];
  baseBranch?: string;
  apply?: boolean;
  verbose?: boolean;
  json?: boolean;
}): Promise<AuditGateResult> {
  const apply = options.apply ?? false;
  const verbose = options.verbose ?? false;
  const baseBranch = options.baseBranch ?? 'main';

  // Determine which pages to audit
  let pageIds = options.pageIds ?? [];
  if (pageIds.length === 0) {
    pageIds = getChangedPageIds(baseBranch);
  }

  if (pageIds.length === 0) {
    const summary = buildMarkdownSummary([], true);
    return {
      pages: [],
      totalPages: 0,
      pagesAudited: 0,
      pagesWithIssues: 0,
      totalInaccurate: 0,
      totalUnsupported: 0,
      passed: true,
      markdownSummary: summary,
    };
  }

  // Filter to pages that actually exist and have citations
  const validPages = pageIds.filter(id => findPageFile(id) !== null);

  console.log(`\nAudit gate: ${validPages.length} page(s) to audit`);
  if (apply) console.log('  Mode: audit + auto-fix');
  console.log('');

  const results: PageAuditResult[] = [];

  for (let i = 0; i < validPages.length; i++) {
    const pageId = validPages[i];
    console.log(`[${i + 1}/${validPages.length}] Auditing: ${pageId}`);

    const filePath = findPageFile(pageId);
    if (!filePath) {
      results.push({
        pageId,
        totalCitations: 0,
        auditRan: false,
        auditExitCode: 0,
        finalAccuracy: null,
        error: 'Page file not found',
      });
      continue;
    }

    const raw = readFileSync(filePath, 'utf-8');
    const body = stripFrontmatter(raw);
    const citations = extractCitationsFromContent(body);

    if (citations.length === 0) {
      console.log(`  No citations — skipping`);
      results.push({
        pageId,
        totalCitations: 0,
        auditRan: false,
        auditExitCode: 0,
        finalAccuracy: null,
      });
      continue;
    }

    console.log(`  ${citations.length} citations found — running audit...`);

    // Run the full audit pipeline as a subprocess
    const exitCode = runAuditForPage(pageId, apply, verbose);

    // Get the final accuracy state from SQLite (cached, no LLM calls)
    const accuracy = await getFinalAccuracy(pageId);

    results.push({
      pageId,
      totalCitations: citations.length,
      auditRan: true,
      auditExitCode: exitCode,
      finalAccuracy: accuracy,
    });

    if (accuracy) {
      const issues = accuracy.inaccurate + accuracy.unsupported;
      if (issues > 0) {
        console.log(`  Result: ${accuracy.inaccurate} inaccurate, ${accuracy.unsupported} unsupported`);
      } else {
        console.log(`  Result: all citations accurate`);
      }
    }
    console.log('');
  }

  // Export dashboard data with all results
  exportDashboardData();

  // Calculate totals
  const totalInaccurate = results.reduce(
    (sum, r) => sum + (r.finalAccuracy?.inaccurate ?? 0), 0,
  );
  const totalUnsupported = results.reduce(
    (sum, r) => sum + (r.finalAccuracy?.unsupported ?? 0), 0,
  );
  const pagesWithIssues = results.filter(
    r => r.finalAccuracy && (r.finalAccuracy.inaccurate > 0),
  ).length;

  // Gate passes if no inaccurate citations remain
  // (unsupported is a warning, not a failure — the source may just not
  // explicitly state what the wiki says, which is common for well-known facts)
  const passed = totalInaccurate === 0;

  const markdownSummary = buildMarkdownSummary(results, passed);

  return {
    pages: results,
    totalPages: validPages.length,
    pagesAudited: results.filter(r => r.auditRan).length,
    pagesWithIssues,
    totalInaccurate,
    totalUnsupported,
    passed,
    markdownSummary,
  };
}

// ── CLI entry point ──────────────────────────────────────────────────────────

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const json = args.json === true;
  const apply = args.apply === true;
  const verbose = args.verbose === true;
  const diff = args.diff === true;
  const baseBranch = typeof args.base === 'string' ? args.base : 'main';
  const c = getColors(json);

  const positional = (args._positional as string[]) || [];

  if (!diff && positional.length === 0) {
    console.error(`${c.red}Error: provide page IDs or use --diff${c.reset}`);
    console.error('  Usage: pnpm crux auto-update audit-gate <page-id> [page-id...]');
    console.error('         pnpm crux auto-update audit-gate --diff');
    console.error('         pnpm crux auto-update audit-gate --diff --apply');
    process.exit(1);
  }

  const result = await runAuditGate({
    pageIds: diff ? undefined : positional,
    baseBranch,
    apply,
    verbose,
    json,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n${c.bold}Audit Gate Summary${c.reset}`);
    console.log(`  Pages: ${result.totalPages} total, ${result.pagesAudited} audited`);
    console.log(`  Inaccurate: ${result.totalInaccurate > 0 ? c.red : c.green}${result.totalInaccurate}${c.reset}`);
    console.log(`  Unsupported: ${result.totalUnsupported > 0 ? c.yellow : c.green}${result.totalUnsupported}${c.reset}`);
    console.log(`  Gate: ${result.passed ? `${c.green}PASSED${c.reset}` : `${c.red}FAILED${c.reset}`}`);
    console.log('');
  }

  process.exit(result.passed ? 0 : 1);
}

// Only run when executed directly (not when imported)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error('Audit gate error:', err.message);
    process.exit(1);
  });
}
