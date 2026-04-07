/**
 * Migrate Citations to Source-Check
 *
 * One-time, additive migration that reads citation_quotes with accuracy verdicts
 * and writes them into the unified source_check_verdicts + source_check_evidence tables.
 *
 * The citation_quotes table is NOT modified — this is purely additive.
 *
 * Usage:
 *   crux tb migrate-citations                        Migrate all citations
 *   crux tb migrate-citations --dry-run              Preview what would be migrated
 *   crux tb migrate-citations --page=anthropic       Migrate just one page
 *   crux tb migrate-citations --limit=50             Migrate at most 50 citations
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { storeSourceCheckEvidence, storeAggregateVerdict } from '../lib/source-check/index.ts';
import type { SourceCheckVerdict } from '../../apps/wiki-server/src/api-types.ts';
import {
  getAllQuotes,
  getQuotesByPage,
  getCitationBrokenQuotes,
  type AllQuotesResult,
  type QuotesByPageResult,
} from '../lib/wiki-server/citations.ts';
import { listPages, type PageListResult } from '../lib/wiki-server/pages.ts';
import { getVerdictByRecord } from '../lib/wiki-server/source-check-client.ts';

// ── Types ──────────────────────────────────────────────────────────────

interface MigrateCitationsOptions extends BaseOptions {
  'dry-run'?: boolean;
  dryRun?: boolean;
  page?: string;
  limit?: string;
}

/** Shape of a citation quote row returned by the wiki-server /quotes/all endpoint */
interface CitationQuoteRow {
  id: number;
  pageId: number;
  pageSlug: string | null;
  footnote: number;
  url: string | null;
  resourceId: string | null;
  claimText: string;
  claimContext: string | null;
  sourceQuote: string | null;
  sourceLocation: string | null;
  quoteVerified: boolean;
  verificationMethod: string | null;
  verificationScore: number | null;
  verifiedAt: string | null;
  sourceTitle: string | null;
  sourceType: string | null;
  extractionModel: string | null;
  claimId: number | null;
  accuracyVerdict: string | null;
  accuracyIssues: string | null;
  accuracyScore: number | null;
  accuracyCheckedAt: string | null;
  accuracySupportingQuotes: string | null;
  verificationDifficulty: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Shape of a page row from the wiki-server /quotes endpoint (per-page) */
interface QuotesByPageResponse {
  quotes: CitationQuoteRow[];
}

/** Shape of the paginated /quotes/all response */
interface AllQuotesResponse {
  quotes: CitationQuoteRow[];
  total: number;
  limit: number;
  offset: number;
}

// ── Verdict Mapping ──────────────────────────────────────────────────

const VERDICT_MAP: Record<string, SourceCheckVerdict> = {
  accurate: 'confirmed',
  inaccurate: 'contradicted',
  unsupported: 'unverifiable',
  minor_issues: 'partial',
  not_verifiable: 'unverifiable',
};

function mapVerdict(accuracyVerdict: string): SourceCheckVerdict | null {
  return VERDICT_MAP[accuracyVerdict] ?? null;
}

/**
 * Build a recordId for a citation in the unified source-check system.
 * Format: page:<pageSlug>:fn<footnote>
 */
function buildRecordId(pageSlug: string, footnote: number): string {
  return `page:${pageSlug}:fn${footnote}`;
}

// ── Fetch Helpers ────────────────────────────────────────────────────

const PAGE_SIZE = 500;

/**
 * Fetch all citation quotes paginated. Returns the complete list.
 */
async function fetchAllQuotes(): Promise<CitationQuoteRow[]> {
  const all: CitationQuoteRow[] = [];
  let offset = 0;

  // First call to get total
  const firstResult = await getAllQuotes(PAGE_SIZE, 0);
  if (!firstResult.ok) {
    throw new Error(`Failed to fetch citations: ${firstResult.error} - ${firstResult.message}`);
  }

  all.push(...(firstResult.data.quotes as unknown as CitationQuoteRow[]));
  const total = firstResult.data.total;
  offset = PAGE_SIZE;

  while (offset < total) {
    const result = await getAllQuotes(PAGE_SIZE, offset);
    if (!result.ok) {
      throw new Error(`Failed to fetch citations at offset ${offset}: ${result.error} - ${result.message}`);
    }
    all.push(...(result.data.quotes as unknown as CitationQuoteRow[]));
    offset += PAGE_SIZE;
  }

  return all;
}

/**
 * Fetch page slug mappings. Uses pages-with-quotes to build a reverse map.
 * Then also fetches all wiki pages for a complete mapping.
 */
async function fetchPageSlugs(): Promise<Map<number, string>> {
  // We need to map integer pageId -> slug. The pages-with-quotes endpoint
  // only has pages with quotes, so we'll use a different approach:
  // fetch wiki pages list to build the mapping.
  const result = await listPages({ limit: 5000 });
  if (!result.ok) {
    throw new Error(`Failed to fetch page list: ${result.error} - ${result.message}`);
  }

  const map = new Map<number, string>();
  for (const page of result.data.pages) {
    // The pages endpoint returns `slug` as the `id` field
    map.set(page.id as unknown as number, page.id);
  }
  return map;
}

/**
 * Fetch quotes for a single page by slug.
 */
async function fetchQuotesForPage(pageSlug: string): Promise<CitationQuoteRow[]> {
  const result = await getQuotesByPage(pageSlug, 500);
  if (!result.ok) {
    throw new Error(`Failed to fetch citations for page ${pageSlug}: ${result.error} - ${result.message}`);
  }
  return result.data.quotes as unknown as CitationQuoteRow[];
}

/**
 * Check if a source-check verdict already exists for a given record.
 */
async function hasExistingVerdict(recordId: string): Promise<boolean> {
  const result = await getVerdictByRecord('citation', recordId);
  // A 404 means no verdict exists
  if (!result.ok) return false;
  return result.data.verdicts.length > 0;
}

// ── Main Command ─────────────────────────────────────────────────────

const LOG_PREFIX = '[migrate-citations]';

async function migrateCommand(
  args: string[],
  options: MigrateCitationsOptions,
): Promise<CommandResult> {
  const dryRun = options['dry-run'] || options.dryRun || false;
  const pageFilter = options.page;
  const limit = options.limit ? parseInt(options.limit, 10) : undefined;

  if (limit !== undefined && (isNaN(limit) || limit < 1)) {
    return { exitCode: 1, output: '--limit must be a positive integer' };
  }

  console.log(`${LOG_PREFIX} Starting citation migration${dryRun ? ' (DRY RUN)' : ''}...`);

  let quotes: CitationQuoteRow[];
  let pageSlugMap: Map<number, string>;

  if (pageFilter) {
    // Single page mode: fetch quotes for that page directly
    console.log(`${LOG_PREFIX} Fetching citations for page: ${pageFilter}`);
    quotes = await fetchQuotesForPage(pageFilter);
    // For single-page mode, we know the slug already
    pageSlugMap = new Map();
    for (const q of quotes) {
      pageSlugMap.set(q.pageId, pageFilter);
    }
  } else {
    // Full mode: fetch all quotes and page mappings
    console.log(`${LOG_PREFIX} Fetching all citation quotes...`);
    quotes = await fetchAllQuotes();
    console.log(`${LOG_PREFIX} Fetched ${quotes.length} citation quotes total`);

    console.log(`${LOG_PREFIX} Fetching page slug mappings...`);
    pageSlugMap = await fetchPageSlugs();
    console.log(`${LOG_PREFIX} Loaded ${pageSlugMap.size} page slug mappings`);
  }

  // Filter to only quotes with an accuracy verdict
  const withVerdicts = quotes.filter((q) => q.accuracyVerdict != null);
  console.log(`${LOG_PREFIX} ${withVerdicts.length} citations have accuracy verdicts`);

  // Apply limit
  const toProcess = limit ? withVerdicts.slice(0, limit) : withVerdicts;
  if (limit && withVerdicts.length > limit) {
    console.log(`${LOG_PREFIX} Limiting to ${limit} citations`);
  }

  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  let unknownPage = 0;

  for (const quote of toProcess) {
    const pageSlug = pageSlugMap.get(quote.pageId);
    if (!pageSlug) {
      unknownPage++;
      if (unknownPage <= 5) {
        console.warn(`${LOG_PREFIX} No slug found for pageId=${quote.pageId}, skipping footnote ${quote.footnote}`);
      }
      continue;
    }

    const recordId = buildRecordId(pageSlug, quote.footnote);
    const mappedVerdict = mapVerdict(quote.accuracyVerdict!);

    if (!mappedVerdict) {
      console.warn(`${LOG_PREFIX} Unknown accuracy verdict "${quote.accuracyVerdict}" for ${recordId}, skipping`);
      errors++;
      continue;
    }

    if (dryRun) {
      console.log(`  [dry-run] Would migrate ${recordId}: ${quote.accuracyVerdict} -> ${mappedVerdict} (confidence: ${quote.accuracyScore ?? 'N/A'})`);
      migrated++;
      continue;
    }

    // Check if already migrated (idempotent)
    try {
      const exists = await hasExistingVerdict(recordId);
      if (exists) {
        skipped++;
        continue;
      }
    } catch (err) {
      // If check fails, proceed with migration attempt anyway
      console.warn(`${LOG_PREFIX} Could not check existing verdict for ${recordId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      // Store evidence
      await storeSourceCheckEvidence({
        recordType: 'citation',
        recordId,
        sourceUrl: quote.url || '',
        verdict: mappedVerdict,
        confidence: quote.accuracyScore ?? 0.5,
        extractedValue: quote.claimText.slice(0, 2000),
        reasoning: quote.accuracyIssues || `Migrated from citation_quotes accuracy check. Original verdict: ${quote.accuracyVerdict}`,
      }, LOG_PREFIX);

      // Store aggregate verdict
      await storeAggregateVerdict({
        recordType: 'citation',
        recordId,
        verdict: mappedVerdict,
        confidence: quote.accuracyScore ?? 0.5,
        reasoning: quote.accuracyIssues || `Migrated from citation_quotes. Original verdict: ${quote.accuracyVerdict}`,
        sourcesChecked: 1,
      }, LOG_PREFIX);

      migrated++;
    } catch (err) {
      errors++;
      console.error(`${LOG_PREFIX} Failed to migrate ${recordId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (unknownPage > 5) {
    console.warn(`${LOG_PREFIX} ${unknownPage} total citations had unresolvable page IDs`);
  }

  const summary = [
    `${LOG_PREFIX} Migration complete${dryRun ? ' (DRY RUN)' : ''}:`,
    `  Migrated: ${migrated}`,
    `  Skipped (already exists): ${skipped}`,
    `  Errors: ${errors}`,
    `  Unknown pages: ${unknownPage}`,
    `  Total with verdicts: ${withVerdicts.length}`,
  ].join('\n');

  console.log(summary);

  return {
    exitCode: errors > 0 ? 1 : 0,
    output: `Migrated ${migrated} citations${dryRun ? ' (dry run)' : ''}, ${skipped} skipped, ${errors} errors`,
  };
}

// ── Exports ──────────────────────────────────────────────────────────

export const commands = {
  default: migrateCommand,
};

export function getHelp(): string {
  return `
Migrate Citations — copy citation accuracy verdicts into the unified source-check system

Usage:
  crux tb migrate-citations                     Migrate all citation accuracy verdicts
  crux tb migrate-citations --dry-run           Preview what would be migrated
  crux tb migrate-citations --page=<slug>       Migrate just one page's citations
  crux tb migrate-citations --limit=50          Migrate at most 50 citations

Options:
  --dry-run          Show what would be migrated without writing anything
  --page=<slug>      Limit to a single page (by slug)
  --limit=N          Maximum number of citations to migrate

This is a one-time additive migration. The citation_quotes table is NOT modified.
Safe to run multiple times — existing source-check verdicts are skipped.

Verdict mapping:
  accurate       -> confirmed
  inaccurate     -> contradicted
  unsupported    -> unverifiable
  minor_issues   -> partial
  not_verifiable -> unverifiable
`.trim();
}
