/**
 * Export Citation Accuracy Dashboard Data
 *
 * Reads accuracy data from the SQLite DB and exports a YAML file
 * to data/citation-accuracy/dashboard.yaml so it's available in
 * production (SQLite is not available on Vercel).
 *
 * Output: data/citation-accuracy/dashboard.yaml
 *
 * Usage:
 *   pnpm crux citations export-dashboard
 *   pnpm crux citations export-dashboard --json
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { citationQuotes, getDb, PROJECT_ROOT, CACHE_DIR } from '../lib/knowledge-db.ts';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';

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

export function buildDashboardExport(): DashboardExport | null {
  const dbPath = join(PROJECT_ROOT, '.cache', 'knowledge.db');
  if (!existsSync(dbPath)) return null;

  // Get all citation quotes
  const allQuotes = getDb().prepare(
    'SELECT * FROM citation_quotes ORDER BY page_id, footnote',
  ).all() as Array<Record<string, unknown>>;

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
  }>();

  // Flagged citations
  const flagged: FlaggedCitation[] = [];

  for (const q of allQuotes) {
    const pageId = q.page_id as string;
    const verdict = q.accuracy_verdict as string | null;
    const score = q.accuracy_score as number | null;
    const difficulty = q.verification_difficulty as string | null;
    const url = q.url as string | null;
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
        domainMap.set(domain, { total: 0, checked: 0, accurate: 0, inaccurate: 0, unsupported: 0 });
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
        if (domain) domainMap.get(domain)!.accurate++;
      }

      // Flag problematic citations
      if (verdict === 'inaccurate' || verdict === 'unsupported') {
        flagged.push({
          pageId,
          footnote: q.footnote as number,
          claimText: q.claim_text as string,
          sourceTitle: q.source_title as string | null,
          url,
          verdict,
          score,
          issues: q.accuracy_issues as string | null,
          difficulty,
          checkedAt: q.accuracy_checked_at as string | null,
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

const OUTPUT_DIR = join(PROJECT_ROOT, 'data', 'citation-accuracy');
const OUTPUT_PATH = join(OUTPUT_DIR, 'dashboard.yaml');

export function exportDashboardData(): string | null {
  const data = buildDashboardExport();
  if (!data) return null;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_PATH, yaml.dump(data, { lineWidth: -1, noRefs: true }));
  return OUTPUT_PATH;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const json = args.json === true;
  const colors = getColors(json);

  const outputPath = exportDashboardData();

  if (!outputPath) {
    if (json) {
      console.log(JSON.stringify({ error: 'No citation data available' }));
    } else {
      console.log(`${colors.yellow}No citation data available.${colors.reset}`);
      console.log(`Run ${colors.bold}pnpm crux citations extract-quotes --all${colors.reset} first.`);
    }
    process.exit(0);
  }

  if (json) {
    const data = buildDashboardExport();
    console.log(JSON.stringify(data, null, 2));
  } else {
    const data = buildDashboardExport()!;
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
