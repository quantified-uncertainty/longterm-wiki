/**
 * Export Citation Accuracy Dashboard Data
 *
 * Exports citation accuracy data from PG (wiki-server) to YAML files
 * so they're available in production (PG is not available on Vercel).
 *
 * Output:
 *   data/citation-accuracy/summary.yaml          — global stats, page summaries, domain analysis
 *   data/citation-accuracy/pages/<pageId>.yaml    — per-page flagged citations
 *
 * Usage:
 *   pnpm crux citations export-dashboard              # Uses PG data
 *   pnpm crux citations export-dashboard --json
 */

import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { getAccuracyDashboard, getAllQuotes } from '../lib/wiki-server/citations.ts';

// ---------------------------------------------------------------------------
// Types (shared with the dashboard — keep in sync)
// ---------------------------------------------------------------------------

export interface DashboardExport {
  exportedAt: string;
  summary: {
    totalCitations: number;
    checkedCitations: number;
    accurateCitations: number;
    inaccurateCitations: number;
    unsupportedCitations: number;
    minorIssueCitations: number;
    uncheckedCitations: number;
    averageScore: number | null;
  };
  verdictDistribution: Record<string, number>;
  difficultyDistribution: Record<string, number>;
  pages: PageSummary[];
  flaggedCitations: FlaggedCitation[];
  domainAnalysis: DomainSummary[];
}

export interface PageSummary {
  pageId: string;
  totalCitations: number;
  checked: number;
  accurate: number;
  inaccurate: number;
  unsupported: number;
  minorIssues: number;
  accuracyRate: number | null;
  avgScore: number | null;
}

export interface FlaggedCitation {
  pageId: string;
  footnote: number;
  claimText: string;
  sourceTitle: string | null;
  url: string | null;
  verdict: string;
  score: number | null;
  issues: string | null;
  difficulty: string | null;
  checkedAt: string | null;
}

export interface DomainSummary {
  domain: string;
  totalCitations: number;
  checked: number;
  accurate: number;
  inaccurate: number;
  unsupported: number;
  minorIssues: number;
  inaccuracyRate: number | null;
}

// ---------------------------------------------------------------------------
// Export logic
// ---------------------------------------------------------------------------

function extractDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export async function buildDashboardExport(): Promise<DashboardExport | null> {
  // Fetch all citation quotes from wiki-server API
  // Note: max 5000 per request. If total exceeds this, data is truncated.
  const quotesResult = await getAllQuotes(5000, 0);
  if (!quotesResult.ok) return null;
  const allQuotes = quotesResult.data.quotes;
  if (quotesResult.data.total > allQuotes.length) {
    console.warn(`Warning: ${quotesResult.data.total} quotes exist but only ${allQuotes.length} fetched (max page size). Dashboard data is incomplete.`);
  }

  if (allQuotes.length === 0) return null;

  // Build verdict and difficulty distributions
  const verdictDist: Record<string, number> = {};
  const difficultyDist: Record<string, number> = {};
  let checkedCount = 0;
  let accurateCount = 0;
  let inaccurateCount = 0;
  let unsupportedCount = 0;
  let minorIssueCount = 0;
  let scoreSum = 0;
  let scoreCount = 0;

  // Page-level aggregation
  const pageMap = new Map<string, {
    total: number;
    checked: number;
    accurate: number;
    inaccurate: number;
    unsupported: number;
    minorIssues: number;
    scoreSum: number;
    scoreCount: number;
  }>();

  // Domain-level aggregation
  const domainMap = new Map<string, {
    total: number;
    checked: number;
    accurate: number;
    inaccurate: number;
    unsupported: number;
    minorIssues: number;
  }>();

  // Flagged citations
  const flagged: FlaggedCitation[] = [];

  for (const q of allQuotes) {
    const pageId = q.pageId;
    if (!pageId) continue; // skip orphaned citations with no resolvable page slug
    const verdict = q.accuracyVerdict;
    const score = q.accuracyScore != null ? Number(q.accuracyScore) : null;
    const difficulty = q.verificationDifficulty;
    const url = q.url;
    const domain = extractDomain(url);

    // Page aggregation
    if (!pageMap.has(pageId)) {
      pageMap.set(pageId, { total: 0, checked: 0, accurate: 0, inaccurate: 0, unsupported: 0, minorIssues: 0, scoreSum: 0, scoreCount: 0 });
    }
    const page = pageMap.get(pageId)!;
    page.total++;

    // Domain aggregation
    if (domain) {
      if (!domainMap.has(domain)) {
        domainMap.set(domain, { total: 0, checked: 0, accurate: 0, inaccurate: 0, unsupported: 0, minorIssues: 0 });
      }
      const d = domainMap.get(domain)!;
      d.total++;
    }

    if (verdict) {
      checkedCount++;
      page.checked++;
      verdictDist[verdict] = (verdictDist[verdict] || 0) + 1;

      if (domain) {
        domainMap.get(domain)!.checked++;
      }

      if (score !== null && Number.isFinite(score)) {
        scoreSum += score;
        scoreCount++;
        page.scoreSum += score;
        page.scoreCount++;
      }

      if (difficulty) {
        difficultyDist[difficulty] = (difficultyDist[difficulty] || 0) + 1;
      }

      if (verdict === 'accurate') {
        accurateCount++;
        page.accurate++;
        if (domain) domainMap.get(domain)!.accurate++;
      } else if (verdict === 'inaccurate') {
        inaccurateCount++;
        page.inaccurate++;
        if (domain) domainMap.get(domain)!.inaccurate++;
      } else if (verdict === 'unsupported') {
        unsupportedCount++;
        page.unsupported++;
        if (domain) domainMap.get(domain)!.unsupported++;
      } else if (verdict === 'minor_issues') {
        minorIssueCount++;
        page.minorIssues++;
        if (domain) domainMap.get(domain)!.minorIssues++;
      }

      // Flag problematic citations
      if (verdict === 'inaccurate' || verdict === 'unsupported') {
        flagged.push({
          pageId,
          footnote: q.footnote,
          claimText: q.claimText,
          sourceTitle: q.sourceTitle,
          url,
          verdict,
          score,
          issues: q.accuracyIssues,
          difficulty,
          checkedAt: q.accuracyCheckedAt ? String(q.accuracyCheckedAt) : null,
        });
      }
    }
  }

  // Build page summaries
  const pages: PageSummary[] = [];
  for (const [pageId, p] of pageMap) {
    pages.push({
      pageId,
      totalCitations: p.total,
      checked: p.checked,
      accurate: p.accurate,
      inaccurate: p.inaccurate,
      unsupported: p.unsupported,
      minorIssues: p.minorIssues,
      accuracyRate: p.checked > 0 ? (p.accurate + p.minorIssues) / p.checked : null,
      avgScore: p.scoreCount > 0 ? Math.round((p.scoreSum / p.scoreCount) * 100) / 100 : null,
    });
  }
  // Sort by inaccuracy rate (worst first), then by total citations
  pages.sort((a, b) => {
    const aInacc = a.checked > 0 ? (a.inaccurate + a.unsupported) / a.checked : 0;
    const bInacc = b.checked > 0 ? (b.inaccurate + b.unsupported) / b.checked : 0;
    if (bInacc !== aInacc) return bInacc - aInacc;
    return b.totalCitations - a.totalCitations;
  });

  // Build domain summaries
  const MIN_DOMAIN_CITATIONS = 2;
  const domains: DomainSummary[] = [];
  for (const [domain, d] of domainMap) {
    if (d.total < MIN_DOMAIN_CITATIONS) continue;
    domains.push({
      domain,
      totalCitations: d.total,
      checked: d.checked,
      accurate: d.accurate,
      inaccurate: d.inaccurate,
      unsupported: d.unsupported,
      minorIssues: d.minorIssues,
      inaccuracyRate: d.checked > 0 ? (d.inaccurate + d.unsupported) / d.checked : null,
    });
  }
  domains.sort((a, b) => {
    const aRate = a.inaccuracyRate ?? 0;
    const bRate = b.inaccuracyRate ?? 0;
    if (bRate !== aRate) return bRate - aRate;
    return b.totalCitations - a.totalCitations;
  });

  // Sort flagged by score (worst first)
  flagged.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

  return {
    exportedAt: new Date().toISOString(),
    summary: {
      totalCitations: allQuotes.length,
      checkedCitations: checkedCount,
      accurateCitations: accurateCount,
      inaccurateCitations: inaccurateCount,
      unsupportedCitations: unsupportedCount,
      minorIssueCitations: minorIssueCount,
      uncheckedCitations: allQuotes.length - checkedCount,
      averageScore: scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 100) / 100 : null,
    },
    verdictDistribution: verdictDist,
    difficultyDistribution: difficultyDist,
    pages,
    flaggedCitations: flagged,
    domainAnalysis: domains,
  };
}

export const ACCURACY_DIR = join(PROJECT_ROOT, 'data', 'citation-accuracy');
export const ACCURACY_PAGES_DIR = join(ACCURACY_DIR, 'pages');
const SUMMARY_PATH = join(ACCURACY_DIR, 'summary.yaml');

/** Max characters for claimText in exported YAML (dashboard uses line-clamp-2 anyway). */
const MAX_CLAIM_LENGTH = 150;

function truncateClaim(text: string): string {
  if (text.length <= MAX_CLAIM_LENGTH) return text;
  return text.slice(0, MAX_CLAIM_LENGTH) + '...';
}

/**
 * Export dashboard data to YAML files.
 * @param fromDbData - If provided, uses this data instead of building from PG
 */
export async function exportDashboardData(fromDbData?: DashboardExport | null): Promise<{ path: string; data: DashboardExport } | null> {
  const data = fromDbData ?? await buildDashboardExport();
  if (!data) return null;
  mkdirSync(ACCURACY_DIR, { recursive: true });
  mkdirSync(ACCURACY_PAGES_DIR, { recursive: true });

  // Group flagged citations by page
  const flaggedByPage = new Map<string, FlaggedCitation[]>();
  for (const fc of data.flaggedCitations) {
    const list = flaggedByPage.get(fc.pageId) || [];
    list.push({ ...fc, claimText: truncateClaim(fc.claimText) });
    flaggedByPage.set(fc.pageId, list);
  }

  // Write per-page flagged citation files
  // Only touch pages present in the current dataset — preserve other pages' YAML
  const pagesInDb = new Set(data.pages.map(p => p.pageId));
  const pagesWithFlagged = new Set(flaggedByPage.keys());
  try {
    for (const f of readdirSync(ACCURACY_PAGES_DIR)) {
      if (f.endsWith('.yaml')) {
        const filePageId = f.replace(/\.yaml$/, '');
        // Remove if page is in DB (either has flagged to rewrite, or was fixed and now has zero)
        if (pagesInDb.has(filePageId)) {
          unlinkSync(join(ACCURACY_PAGES_DIR, f));
        }
        // Pages NOT in the DB are left untouched (from earlier audit runs)
      }
    }
  } catch { /* dir may not exist yet */ }

  for (const [pageId, citations] of flaggedByPage) {
    const pagePath = join(ACCURACY_PAGES_DIR, `${pageId}.yaml`);
    writeFileSync(pagePath, yaml.dump(citations, { lineWidth: -1, noRefs: true }));
  }

  // Write summary (without flaggedCitations — those are in per-page files)
  const summary = {
    exportedAt: data.exportedAt,
    summary: data.summary,
    verdictDistribution: data.verdictDistribution,
    difficultyDistribution: data.difficultyDistribution,
    pages: data.pages,
    domainAnalysis: data.domainAnalysis,
  };
  writeFileSync(SUMMARY_PATH, yaml.dump(summary, { lineWidth: -1, noRefs: true }));

  // Remove old monolithic file if it exists
  const oldPath = join(ACCURACY_DIR, 'dashboard.yaml');
  try { unlinkSync(oldPath); } catch { /* may not exist */ }

  return { path: SUMMARY_PATH, data };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const json = args.json === true;
  const localOnly = args['local-only'] === true;
  const colors = getColors(json);

  // Fetch data from PG (wiki-server).
  let dbData: DashboardExport | null = null;
  if (!localOnly) {
    const serverUp = await isServerAvailable();
    if (serverUp) {
      const dashboardResult = await getAccuracyDashboard();
      if (dashboardResult.ok) {
        dbData = dashboardResult.data;
        if (!json) {
          console.log(`${colors.dim}Using data from wiki-server DB${colors.reset}`);
        }
      } else if (!json) {
        console.log(`${colors.dim}Wiki server returned no data (${dashboardResult.error})${colors.reset}`);
      }
    } else if (!json) {
      console.log(`${colors.dim}Wiki server not available${colors.reset}`);
    }
  }

  const result = await exportDashboardData(dbData);

  if (!result) {
    if (json) {
      console.log(JSON.stringify({ error: 'No citation data available' }));
    } else {
      console.log(`${colors.yellow}No citation data available.${colors.reset}`);
      console.log(`Run ${colors.bold}pnpm crux citations extract-quotes --all${colors.reset} first.`);
    }
    process.exit(0);
  }

  const { path: outputPath, data } = result;

  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const c = colors;
    console.log(`\n${c.bold}${c.blue}Citation Accuracy Dashboard Export${c.reset}\n`);
    console.log(`  Exported to: ${c.bold}${outputPath}${c.reset}`);
    console.log(`  Total citations: ${data.summary.totalCitations}`);
    console.log(`  Checked: ${data.summary.checkedCitations}`);
    console.log(`  ${c.green}Accurate:${c.reset} ${data.summary.accurateCitations}`);
    if (data.summary.inaccurateCitations > 0) {
      console.log(`  ${c.red}Inaccurate:${c.reset} ${data.summary.inaccurateCitations}`);
    }
    if (data.summary.unsupportedCitations > 0) {
      console.log(`  ${c.red}Unsupported:${c.reset} ${data.summary.unsupportedCitations}`);
    }
    console.log(`  Pages: ${data.pages.length}`);
    console.log(`  Flagged: ${data.flaggedCitations.length}`);
    console.log(`  Domains: ${data.domainAnalysis.length}`);
    console.log('');
  }
}

// Only run when executed directly (not when imported in tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
