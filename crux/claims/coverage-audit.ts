/**
 * Coverage Audit — gap analysis between citation_quotes and claims systems
 *
 * Shows how much of the citation_quotes data has been migrated into the claims
 * architecture (claims + claim_sources + claim_page_references).
 *
 * This is step 1 of the citation_quotes → claims consolidation (issue #1194).
 *
 * Usage:
 *   pnpm crux claims coverage-audit              # summary report
 *   pnpm crux claims coverage-audit --json        # machine-readable output
 *   pnpm crux claims coverage-audit --per-page    # include per-page breakdown
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { apiRequest, isServerAvailable } from '../lib/wiki-server/client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CitationQuoteRow {
  id: number;
  pageId: string;
  footnote: number;
  url: string | null;
  claimText: string;
  claimId: number | null;
  quoteVerified: boolean;
  accuracyVerdict: string | null;
}

interface AllQuotesResponse {
  quotes: CitationQuoteRow[];
  total: number;
  limit: number;
  offset: number;
}

interface ClaimRow {
  id: number;
  entityId: string;
  claimText: string;
  pageReferences?: Array<{
    id: number;
    claimId: number;
    pageId: string;
    footnote: number | null;
    section: string | null;
  }>;
}

interface AllClaimsResponse {
  claims: ClaimRow[];
  total: number;
  limit: number;
  offset: number;
}

interface ClaimStatsResponse {
  total: number;
  [key: string]: unknown;
}

interface PageGap {
  pageId: string;
  totalQuotes: number;
  linkedQuotes: number;
  unlinkedQuotes: number;
  coveragePercent: number;
}

interface AuditReport {
  timestamp: string;
  citationQuotes: {
    total: number;
    withClaimId: number;
    withoutClaimId: number;
    coveragePercent: number;
    verified: number;
    withAccuracyVerdict: number;
  };
  claims: {
    total: number;
    withPageReferences: number;
    withoutPageReferences: number;
    uniqueEntities: number;
  };
  pageBreakdown: PageGap[];
  summary: {
    pagesWithQuotes: number;
    pagesFullyCovered: number;
    pagesPartiallyCovered: number;
    pagesWithNoCoverage: number;
  };
}

// ---------------------------------------------------------------------------
// Paginated fetchers
// ---------------------------------------------------------------------------

async function fetchAllQuotes(): Promise<CitationQuoteRow[]> {
  const PAGE_SIZE = 500;
  const all: CitationQuoteRow[] = [];
  let offset = 0;

  while (true) {
    const result = await apiRequest<AllQuotesResponse>(
      'GET',
      `/api/citations/quotes/all?limit=${PAGE_SIZE}&offset=${offset}`,
      undefined,
      30_000,
    );

    if (!result.ok) {
      throw new Error(`Failed to fetch citation quotes: ${result.message}`);
    }

    all.push(...result.data.quotes);

    if (result.data.quotes.length < PAGE_SIZE || all.length >= result.data.total) {
      break;
    }
    offset += result.data.quotes.length;
  }

  return all;
}

async function fetchAllClaims(): Promise<ClaimRow[]> {
  const PAGE_SIZE = 200;
  const all: ClaimRow[] = [];
  let offset = 0;

  while (true) {
    const result = await apiRequest<AllClaimsResponse>(
      'GET',
      `/api/claims/all?limit=${PAGE_SIZE}&offset=${offset}&includePageReferences=true`,
      undefined,
      30_000,
    );

    if (!result.ok) {
      throw new Error(`Failed to fetch claims: ${result.message}`);
    }

    all.push(...result.data.claims);

    if (result.data.claims.length < PAGE_SIZE || all.length >= result.data.total) {
      break;
    }
    offset += result.data.claims.length;
  }

  return all;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function buildReport(
  quotes: CitationQuoteRow[],
  claims: ClaimRow[],
): AuditReport {
  // Citation quotes analysis
  const withClaimId = quotes.filter(q => q.claimId != null);
  const withoutClaimId = quotes.filter(q => q.claimId == null);
  const verified = quotes.filter(q => q.quoteVerified);
  const withAccuracy = quotes.filter(q => q.accuracyVerdict != null);

  // Claims analysis
  const claimsWithRefs = claims.filter(
    c => c.pageReferences && c.pageReferences.length > 0,
  );
  const claimsWithoutRefs = claims.filter(
    c => !c.pageReferences || c.pageReferences.length === 0,
  );
  const uniqueEntities = new Set(claims.map(c => c.entityId));

  // Per-page breakdown from citation_quotes
  const byPage = new Map<string, { total: number; linked: number }>();
  for (const q of quotes) {
    const entry = byPage.get(q.pageId) ?? { total: 0, linked: 0 };
    entry.total++;
    if (q.claimId != null) {
      entry.linked++;
    }
    byPage.set(q.pageId, entry);
  }

  const pageBreakdown: PageGap[] = [];
  for (const [pageId, counts] of byPage) {
    pageBreakdown.push({
      pageId,
      totalQuotes: counts.total,
      linkedQuotes: counts.linked,
      unlinkedQuotes: counts.total - counts.linked,
      coveragePercent: counts.total > 0
        ? Math.round((counts.linked / counts.total) * 100)
        : 100,
    });
  }

  // Sort by unlinked quotes descending (biggest gaps first)
  pageBreakdown.sort((a, b) => b.unlinkedQuotes - a.unlinkedQuotes);

  const pagesFullyCovered = pageBreakdown.filter(p => p.coveragePercent === 100).length;
  const pagesWithNoCoverage = pageBreakdown.filter(p => p.coveragePercent === 0).length;
  const pagesPartiallyCovered = pageBreakdown.length - pagesFullyCovered - pagesWithNoCoverage;

  return {
    timestamp: new Date().toISOString(),
    citationQuotes: {
      total: quotes.length,
      withClaimId: withClaimId.length,
      withoutClaimId: withoutClaimId.length,
      coveragePercent: quotes.length > 0
        ? Math.round((withClaimId.length / quotes.length) * 100)
        : 100,
      verified: verified.length,
      withAccuracyVerdict: withAccuracy.length,
    },
    claims: {
      total: claims.length,
      withPageReferences: claimsWithRefs.length,
      withoutPageReferences: claimsWithoutRefs.length,
      uniqueEntities: uniqueEntities.size,
    },
    pageBreakdown,
    summary: {
      pagesWithQuotes: pageBreakdown.length,
      pagesFullyCovered,
      pagesPartiallyCovered,
      pagesWithNoCoverage,
    },
  };
}

// ---------------------------------------------------------------------------
// Pretty print
// ---------------------------------------------------------------------------

function printReport(report: AuditReport, showPerPage: boolean): void {
  const c = getColors();

  console.log();
  console.log(`${c.bold}Claims Coverage Audit${c.reset}`);
  console.log(`${c.dim}Gap analysis: citation_quotes vs claims architecture${c.reset}`);
  console.log();

  // Citation quotes summary
  console.log(`${c.bold}Citation Quotes${c.reset}`);
  console.log(`  Total:                ${c.cyan}${report.citationQuotes.total}${c.reset}`);
  console.log(`  Linked to claims:     ${c.green}${report.citationQuotes.withClaimId}${c.reset} (${report.citationQuotes.coveragePercent}%)`);
  console.log(`  Not linked (gap):     ${c.yellow}${report.citationQuotes.withoutClaimId}${c.reset}`);
  console.log(`  Verified:             ${report.citationQuotes.verified}`);
  console.log(`  With accuracy verdict: ${report.citationQuotes.withAccuracyVerdict}`);
  console.log();

  // Claims summary
  console.log(`${c.bold}Claims${c.reset}`);
  console.log(`  Total:                ${c.cyan}${report.claims.total}${c.reset}`);
  console.log(`  With page references: ${c.green}${report.claims.withPageReferences}${c.reset}`);
  console.log(`  Orphaned (no refs):   ${c.yellow}${report.claims.withoutPageReferences}${c.reset}`);
  console.log(`  Unique entities:      ${report.claims.uniqueEntities}`);
  console.log();

  // Page summary
  console.log(`${c.bold}Page Coverage Summary${c.reset}`);
  console.log(`  Pages with quotes:      ${report.summary.pagesWithQuotes}`);
  console.log(`  Fully covered (100%):   ${c.green}${report.summary.pagesFullyCovered}${c.reset}`);
  console.log(`  Partially covered:      ${c.yellow}${report.summary.pagesPartiallyCovered}${c.reset}`);
  console.log(`  No coverage (0%):       ${c.red}${report.summary.pagesWithNoCoverage}${c.reset}`);
  console.log();

  // Per-page breakdown (top 30 by gap size)
  if (showPerPage) {
    const display = report.pageBreakdown.filter(p => p.unlinkedQuotes > 0).slice(0, 30);
    if (display.length > 0) {
      console.log(`${c.bold}Per-Page Gaps${c.reset} (top ${display.length} pages with unlinked quotes)`);
      console.log(`${'  Page'.padEnd(40)} ${'Total'.padStart(7)} ${'Linked'.padStart(7)} ${'Gap'.padStart(7)} ${'Cov%'.padStart(7)}`);
      console.log(`${'  ' + '-'.repeat(38)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(7)}`);

      for (const p of display) {
        const name = p.pageId.length > 36 ? p.pageId.slice(0, 33) + '...' : p.pageId;
        const covColor = p.coveragePercent >= 80
          ? c.green
          : p.coveragePercent >= 40
            ? c.yellow
            : c.red;
        console.log(
          `  ${name.padEnd(38)} ${String(p.totalQuotes).padStart(7)} ${String(p.linkedQuotes).padStart(7)} ${c.yellow}${String(p.unlinkedQuotes).padStart(7)}${c.reset} ${covColor}${String(p.coveragePercent + '%').padStart(7)}${c.reset}`,
        );
      }

      const remaining = report.pageBreakdown.filter(p => p.unlinkedQuotes > 0).length - display.length;
      if (remaining > 0) {
        console.log(`  ${c.dim}...and ${remaining} more pages with gaps${c.reset}`);
      }
    } else {
      console.log(`${c.green}All citation_quotes are linked to claims!${c.reset}`);
    }
    console.log();
  }

  // Migration estimate
  const gap = report.citationQuotes.withoutClaimId;
  if (gap > 0) {
    console.log(`${c.bold}Migration Estimate${c.reset}`);
    console.log(`  ${c.yellow}${gap}${c.reset} citation_quotes need to be migrated into the claims architecture.`);
    console.log(`  Use ${c.cyan}pnpm crux claims backfill-from-citations${c.reset} to start migration.`);
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors();

  const jsonOutput = args['json'] === true;
  const showPerPage = args['per-page'] === true || jsonOutput;

  if (!jsonOutput) {
    console.log(`${c.dim}Checking wiki-server availability...${c.reset}`);
  }

  const available = await isServerAvailable();
  if (!available) {
    if (jsonOutput) {
      console.log(JSON.stringify({ error: 'wiki-server not available' }));
    } else {
      console.error(`${c.red}Wiki-server is not available.${c.reset}`);
      console.error(`Start it with: cd apps/wiki-server && pnpm dev`);
    }
    process.exit(1);
  }

  if (!jsonOutput) {
    console.log(`${c.dim}Fetching citation quotes...${c.reset}`);
  }
  const quotes = await fetchAllQuotes();

  if (!jsonOutput) {
    console.log(`${c.dim}Fetched ${quotes.length} citation quotes${c.reset}`);
    console.log(`${c.dim}Fetching claims (with page references)...${c.reset}`);
  }
  const claims = await fetchAllClaims();

  if (!jsonOutput) {
    console.log(`${c.dim}Fetched ${claims.length} claims${c.reset}`);
  }

  const report = buildReport(quotes, claims);

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report, showPerPage);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Coverage audit failed:', err);
    process.exit(1);
  });
}
