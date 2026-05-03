/**
 * Source-Check Wiki Pages
 *
 * Verifies factual claims in wiki page prose content against their cited sources.
 * Extracts claims via LLM, matches to footnotes, cross-references FactBase,
 * detects stale temporal references, and runs sourcing.
 *
 * Usage:
 *   crux w sourcing-wiki-pages --dry-run                Preview what would be checked
 *   crux w sourcing-wiki-pages --limit=5 --budget=2     Check up to 5 pages, $2 budget
 *   crux w sourcing-wiki-pages --page=anthropic         Check a single page
 *   crux w sourcing-wiki-pages --min-importance=70      Only high-importance pages
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { truncate } from '../lib/text-utils.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import {
  loadPages,
  type PageEntry,
  CONTENT_DIR_ABS,
  PROJECT_ROOT,
} from '../lib/content-types.ts';
import { loadGraphFull } from '../lib/factbase-loader.ts';
import type { LoadedKB } from '../lib/factbase-loader.ts';
import { formatFactValue } from '../../packages/factbase/src/format.ts';
import { createLlmClient } from '../lib/llm.ts';
import {
  extractWikiPageClaims,
  fetchSourceContent,
  callLlmForSourcing,
  storeSourcingEvidence,
  storeAggregateVerdict,
} from '../lib/sourcing/index.ts';
import {
  SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES,
  SOURCE_CHECK_ADDITIONAL_CONSIDERATIONS,
  SOURCE_CHECK_RESPONSE_FORMAT,
} from '../lib/sourcing/prompt-guidelines.ts';
import { SOURCE_CHECK_CONSTANTS } from '../lib/sourcing/types.ts';
import type { WikiPageVerifyItem } from '../lib/sourcing/types.ts';
import type { SourcingVerdict } from '../../apps/wiki-server/src/api-types.ts';
import type { FactBaseFact } from '../lib/sourcing/wiki-page-claims.ts';

// ── Constants ────────────────────────────────────────────────────────

const LOG_PREFIX = '[sourcing-wiki]';

/**
 * Estimated cost per page (includes claim extraction LLM call + per-claim checks).
 * Claim extraction alone costs ~$0.02; each sourced claim check costs ~$0.01.
 * Average page has ~5 sourced claims, so ~$0.07 per page.
 */
const ESTIMATED_COST_PER_PAGE = 0.07;

// ── Types ────────────────────────────────────────────────────────────

interface WikiPagesOptions extends BaseOptions {
  budget?: string;
  limit?: string;
  page?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  'min-importance'?: string;
  minImportance?: string;
  ci?: boolean;
}

interface PageSourcingResult {
  pageSlug: string;
  pageTitle: string;
  totalClaims: number;
  sourcedClaims: number;
  unfootnotedClaims: number;
  crossRefClaims: number;
  staleClaims: number;
  verified: number;
  confirmed: number;
  contradicted: number;
  unverifiable: number;
  outdated: number;
  partial: number;
  /**
   * QUA-426: present for completeness so `result[verdict]++` type-checks
   * over the full SourcingVerdict union. Wiki-page claim verification does
   * not run the pre-LLM relevance gate (which only fires for record-kind
   * items in item-verifier.ts), so this counter should stay at 0 in practice.
   */
  not_applicable: number;
  errors: number;
  /**
   * Number of times an evidence/verdict storage call failed (issue #4017).
   * The verdict was computed but never persisted to the wiki-server.
   * Caller should treat any value > 0 as a hard failure (non-zero exit code).
   */
  storageErrors: number;
  claimResults: ClaimVerifyResult[];
  claimErrors: ClaimVerifyError[];
}

interface ClaimVerifyResult {
  claimText: string;
  category: string;
  verdict: SourcingVerdict;
  confidence: number;
  extractedValue: string;
  reasoning: string;
  sourceUrl: string;
  fieldName: string;
}

interface ClaimVerifyError {
  claimText: string;
  category: string;
  error: string;
  fieldName: string;
}

// ── MDX file resolution ──────────────────────────────────────────────

/**
 * Resolve a PageEntry to its MDX file path on disk.
 * Tries multiple strategies: filePath field, path-based lookup, slug-based search.
 */
function resolvePageMdxPath(page: PageEntry): string | null {
  // Strategy 1: Use filePath if available
  if (page.filePath) {
    const absPath = join(PROJECT_ROOT, page.filePath);
    if (existsSync(absPath)) return absPath;
  }

  // Strategy 2: Use path field (most common)
  // Paths may have leading/trailing slashes like "/knowledge-base/organizations/anthropic/"
  if (page.path) {
    const cleanPath = page.path.replace(/^\/+|\/+$/g, '');
    const pathCandidate = join(CONTENT_DIR_ABS, `${cleanPath}.mdx`);
    if (existsSync(pathCandidate)) return pathCandidate;
  }

  // Strategy 3: Use page id as slug
  if (page.id) {
    const idCandidate = join(CONTENT_DIR_ABS, `${page.id}.mdx`);
    if (existsSync(idCandidate)) return idCandidate;
  }

  return null;
}

/**
 * Extract the page slug for use as a record ID.
 * Uses page.id which is the unique slug (e.g., "anthropic").
 */
function extractPageSlug(page: PageEntry): string {
  return page.id;
}

// ── FactBase data loading ─────────────────────────────────────────────

/**
 * Load FactBase facts for a given entity name, returning them in the format
 * expected by extractWikiPageClaims.
 */
function getFactsForEntity(
  kb: LoadedKB,
  entityName: string,
): FactBaseFact[] {
  const graph = kb.graph;
  const facts: FactBaseFact[] = [];

  // Find the entity by name (case-insensitive)
  for (const entity of graph.getAllEntities()) {
    if (entity.name.toLowerCase() !== entityName.toLowerCase()) continue;

    const entityFacts = graph.getFacts(entity.id);
    for (const fact of entityFacts) {
      if (fact.id.startsWith('inv_')) continue; // Skip inverse facts
      const property = graph.getProperty(fact.propertyId);
      const formattedValue = formatFactValue(fact, property, graph);

      facts.push({
        id: fact.id,
        property: property?.name ?? fact.propertyId,
        value: formattedValue,
      });
    }
    break; // Found the entity, no need to continue
  }

  return facts;
}

// ── Field name generation ──────────────────────────────────────────────

/**
 * Generate a field name for a wiki page sourcing item.
 * This is used as part of the record key in the sourcing system.
 */
function generateFieldName(item: WikiPageVerifyItem): string {
  switch (item.category) {
    case 'sourced-claim':
      if (item.footnoteNumber !== undefined) {
        return `fn:${item.footnoteNumber}`;
      }
      // Fallback for sourced claims without footnote numbers
      return `_sourced:${shortHash(item.claimText)}`;

    case 'unfootnoted-claim':
      return `_unfootnoted:${shortHash(item.claimText)}`;

    case 'cross-ref-claim':
      return `_cross-ref:${item.factId ?? shortHash(item.claimText)}`;

    case 'stale-temporal-claim':
      return `_stale:${shortHash(item.claimText)}`;

    default:
      return `_unknown:${shortHash(item.claimText)}`;
  }
}

/** Generate a short hash of a string for deduplication. */
function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

// ── Claim sourcing ─────────────────────────────────────────────────

/**
 * Build a sourcing prompt for a wiki page claim.
 */
function buildWikiClaimSourcingPrompt(
  item: WikiPageVerifyItem,
  sourceText: string,
): string {
  return `You are a fact-checker. Given the source text below, verify this claim from a wiki page.

Claim: ${item.claimText}
Claim type: ${item.claimType}
Page: ${item.pageSlug}

Source URL: ${item.sourceUrl}

Source text (excerpt):
---
${sourceText.slice(0, SOURCE_CHECK_CONSTANTS.PROMPT_CONTENT_LENGTH)}
---

Context from the wiki page where this claim appears:
${item.sourceContext.slice(0, 500)}

Does the source text confirm, contradict, or not address this claim?

${SOURCE_CHECK_FALSE_POSITIVE_GUIDELINES}

${SOURCE_CHECK_ADDITIONAL_CONSIDERATIONS}

${SOURCE_CHECK_RESPONSE_FORMAT}`;
}

/**
 * Verify a single sourced claim by fetching its source URL and calling the LLM.
 */
async function verifySourcedClaim(
  item: WikiPageVerifyItem,
  client: ReturnType<typeof createLlmClient>,
): Promise<ClaimVerifyResult | ClaimVerifyError> {
  const fieldName = generateFieldName(item);

  if (!item.sourceUrl) {
    return {
      claimText: item.claimText,
      category: item.category,
      error: 'No source URL available',
      fieldName,
    };
  }

  // Fetch source content
  const fetchResult = await fetchSourceContent(item.sourceUrl);
  if (!fetchResult.content) {
    return {
      claimText: item.claimText,
      category: item.category,
      error: fetchResult.errorMessage ?? 'Could not fetch source content',
      fieldName,
    };
  }

  // Build prompt and call LLM
  const prompt = buildWikiClaimSourcingPrompt(item, fetchResult.content);

  try {
    const llmResult = await callLlmForSourcing(
      client,
      prompt,
      `wiki-${item.pageSlug}-${fieldName}`,
    );

    return {
      claimText: item.claimText,
      category: item.category,
      verdict: llmResult.verdict as SourcingVerdict,
      confidence: llmResult.confidence,
      extractedValue: llmResult.extractedValue,
      reasoning: llmResult.reasoning,
      sourceUrl: item.sourceUrl,
      fieldName,
    };
  } catch (e: unknown) {
    return {
      claimText: item.claimText,
      category: item.category,
      error: `LLM call failed: ${e instanceof Error ? e.message : String(e)}`,
      fieldName,
    };
  }
}

// ── Result storage ───────────────────────────────────────────────────

/**
 * Store sourcing results for a wiki page claim.
 */
async function storeClaimResult(
  pageSlug: string,
  result: ClaimVerifyResult,
): Promise<void> {
  // Store evidence
  await storeSourcingEvidence({
    recordType: 'wiki-page',
    recordId: pageSlug,
    sourceUrl: result.sourceUrl,
    verdict: result.verdict,
    confidence: result.confidence,
    extractedValue: result.extractedValue,
    reasoning: result.reasoning,
  }, LOG_PREFIX);
}

/**
 * Store the aggregate verdict for a wiki page after all claims are checked.
 */
async function storePageVerdict(
  pageSlug: string,
  pageResult: PageSourcingResult,
): Promise<void> {
  // Determine the aggregate verdict for the page
  let aggregateVerdict: SourcingVerdict;
  if (pageResult.contradicted > 0) {
    aggregateVerdict = 'contradicted';
  } else if (pageResult.outdated > 0) {
    aggregateVerdict = 'outdated';
  } else if (pageResult.partial > 0) {
    aggregateVerdict = 'partial';
  } else if (pageResult.confirmed > 0) {
    aggregateVerdict = 'confirmed';
  } else {
    aggregateVerdict = 'unverifiable';
  }

  const confidence = pageResult.verified > 0
    ? pageResult.claimResults.reduce((sum, r) => sum + r.confidence, 0) / pageResult.verified
    : 0;

  const reasoning = [
    `Checked ${pageResult.totalClaims} claims`,
    `(${pageResult.sourcedClaims} sourced, ${pageResult.unfootnotedClaims} unfootnoted, ${pageResult.crossRefClaims} cross-ref, ${pageResult.staleClaims} stale)`,
    `Verified ${pageResult.verified}: ${pageResult.confirmed} confirmed, ${pageResult.contradicted} contradicted, ${pageResult.partial} partial, ${pageResult.outdated} outdated, ${pageResult.unverifiable} unverifiable`,
    pageResult.errors > 0 ? `${pageResult.errors} errors` : '',
  ].filter(Boolean).join('. ');

  try {
    await storeAggregateVerdict({
      recordType: 'wiki-page',
      recordId: pageSlug,
      verdict: aggregateVerdict,
      confidence,
      reasoning,
      sourcesChecked: pageResult.verified,
    }, LOG_PREFIX);
  } catch (e: unknown) {
    // Issue #4017 — storage failure must surface, not be silently swallowed.
    pageResult.storageErrors++;
    console.warn(`${LOG_PREFIX} Failed to store page verdict for ${pageSlug}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Page processing ───────────────────────────────────────────────────

/**
 * Process a single wiki page: extract claims, verify sourced ones, record results.
 */
async function processPage(
  page: PageEntry,
  mdxPath: string,
  client: ReturnType<typeof createLlmClient>,
  kb: LoadedKB | null,
): Promise<PageSourcingResult> {
  const pageSlug = extractPageSlug(page);
  const mdxContent = readFileSync(mdxPath, 'utf-8');

  // Load FactBase facts for cross-referencing (if KB is available)
  const facts: FactBaseFact[] = kb ? getFactsForEntity(kb, page.title) : [];

  // Extract claims
  const claims = await extractWikiPageClaims(pageSlug, mdxContent, facts);

  const result: PageSourcingResult = {
    pageSlug,
    pageTitle: page.title,
    totalClaims: claims.length,
    sourcedClaims: claims.filter(c => c.category === 'sourced-claim').length,
    unfootnotedClaims: claims.filter(c => c.category === 'unfootnoted-claim').length,
    crossRefClaims: claims.filter(c => c.category === 'cross-ref-claim').length,
    staleClaims: claims.filter(c => c.category === 'stale-temporal-claim').length,
    verified: 0,
    confirmed: 0,
    contradicted: 0,
    unverifiable: 0,
    outdated: 0,
    partial: 0,
    not_applicable: 0,
    errors: 0,
    storageErrors: 0,
    claimResults: [],
    claimErrors: [],
  };

  // Process each claim by category
  for (const claim of claims) {
    switch (claim.category) {
      case 'sourced-claim': {
        // Verify against source URL
        const verifyResult = await verifySourcedClaim(claim, client);

        if ('error' in verifyResult) {
          result.errors++;
          result.claimErrors.push(verifyResult);
          console.log(`      \x1b[31mERROR: ${verifyResult.error}\x1b[0m`);
        } else {
          result.verified++;
          result[verifyResult.verdict]++;
          result.claimResults.push(verifyResult);

          const color = verifyResult.verdict === 'confirmed'
            ? '\x1b[32m'
            : verifyResult.verdict === 'contradicted'
              ? '\x1b[31m'
              : '\x1b[33m';
          console.log(`      ${color}${verifyResult.verdict}\x1b[0m [fn:${claim.footnoteNumber}] ${claim.claimText.slice(0, 60)}`);

          // Issue #4017 — primary-data write must surface failures, not silently swallow.
          try {
            await storeClaimResult(pageSlug, verifyResult);
          } catch (e: unknown) {
            result.storageErrors++;
            console.warn(`      \x1b[33mStorage failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m`);
          }
        }
        break;
      }

      case 'unfootnoted-claim': {
        // Record as unverifiable (no source to check against)
        const fieldName = generateFieldName(claim);
        result.claimErrors.push({
          claimText: claim.claimText,
          category: claim.category,
          error: 'No footnote/source — claim cannot be verified',
          fieldName,
        });
        console.log(`      \x1b[33munfootnoted\x1b[0m ${claim.claimText.slice(0, 60)}`);
        break;
      }

      case 'cross-ref-claim': {
        // Record FactBase mismatch
        const fieldName = generateFieldName(claim);
        const crossRefResult: ClaimVerifyResult = {
          claimText: claim.claimText,
          category: claim.category,
          verdict: 'contradicted',
          confidence: 0.7,
          extractedValue: `FactBase value: ${claim.factValue ?? 'unknown'}`,
          reasoning: `Wiki page claim does not match FactBase data (fact ${claim.factId})`,
          sourceUrl: '',
          fieldName,
        };
        result.verified++;
        result.contradicted++;
        result.claimResults.push(crossRefResult);
        console.log(`      \x1b[31mcross-ref mismatch\x1b[0m [fact:${claim.factId}] ${claim.claimText.slice(0, 60)}`);

        // Issue #4017 — primary-data write must surface failures, not silently swallow.
        try {
          await storeSourcingEvidence({
            recordType: 'wiki-page',
            recordId: pageSlug,
            sourceUrl: '',
            verdict: 'contradicted',
            confidence: 0.7,
            extractedValue: `FactBase says: ${claim.factValue ?? 'unknown'}`,
            reasoning: `Cross-reference mismatch with FactBase fact ${claim.factId}`,
          }, LOG_PREFIX);
        } catch (e: unknown) {
          result.storageErrors++;
          console.warn(`      \x1b[33mStorage failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m`);
        }
        break;
      }

      case 'stale-temporal-claim': {
        // Record as outdated
        const fieldName = generateFieldName(claim);
        const staleResult: ClaimVerifyResult = {
          claimText: claim.claimText,
          category: claim.category,
          verdict: 'outdated',
          confidence: 0.6,
          extractedValue: '',
          reasoning: 'Claim references temporal data that may be stale (>1 year old)',
          sourceUrl: '',
          fieldName,
        };
        result.verified++;
        result.outdated++;
        result.claimResults.push(staleResult);
        console.log(`      \x1b[33mstale temporal\x1b[0m ${claim.claimText.slice(0, 60)}`);

        // Issue #4017 — primary-data write must surface failures, not silently swallow.
        try {
          await storeSourcingEvidence({
            recordType: 'wiki-page',
            recordId: pageSlug,
            sourceUrl: '',
            verdict: 'outdated',
            confidence: 0.6,
            extractedValue: '',
            reasoning: `Stale temporal reference in claim: ${claim.claimText.slice(0, 200)}`,
          }, LOG_PREFIX);
        } catch (e: unknown) {
          result.storageErrors++;
          console.warn(`      \x1b[33mStorage failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m`);
        }
        break;
      }
    }
  }

  // Store aggregate page verdict (best-effort)
  if (result.verified > 0) {
    await storePageVerdict(pageSlug, result);
  }

  return result;
}

// ── Main command ────────────────────────────────────────────────────────

async function sourcingWikiPagesCommand(
  _args: string[],
  options: WikiPagesOptions,
): Promise<CommandResult> {
  const isDryRun = options['dry-run'] || options.dryRun;
  const budgetLimit = options.budget ? parseFloat(String(options.budget)) : 5.0;
  const pageLimit = options.limit ? parseInt(String(options.limit), 10) : 10;
  const singlePage = options.page as string | undefined;
  const minImportance = options['min-importance'] || options.minImportance
    ? parseFloat(String(options['min-importance'] || options.minImportance))
    : undefined;

  console.log('\x1b[1mWiki Page Source-Check\x1b[0m');
  console.log('');

  // ── Step 1: Load data ──
  console.log('Loading data...');
  const pages = loadPages();

  if (pages.length === 0) {
    return {
      exitCode: 1,
      output: 'No pages found. Run `pnpm build-data:content` first.',
    };
  }

  // Load FactBase (optional — continue without it if unavailable)
  let kb: LoadedKB | null = null;
  try {
    kb = await loadGraphFull();
    console.log(`  FactBase loaded (${kb.graph.getAllEntities().length} entities)`);
  } catch (e: unknown) {
    console.warn(`  FactBase unavailable: ${e instanceof Error ? e.message : String(e)}`);
    console.warn('  Cross-referencing will be skipped.');
  }

  // ── Step 2: Filter and sort pages ──
  let candidatePages = pages.filter(p => {
    // Exclude internal/dashboard pages
    if (p.category === 'internal' || p.subcategory === 'dashboards') return false;
    // Exclude schema/guides/project pages
    if (p.category === 'schema' || p.category === 'guides' || p.category === 'dashboard') return false;
    return true;
  });

  // Apply single-page filter (match by id/slug, or by path including slashes)
  if (singlePage) {
    candidatePages = candidatePages.filter(p => {
      return p.id === singlePage
        || p.path === singlePage
        || p.path?.replace(/^\/+|\/+$/g, '') === singlePage;
    });

    if (candidatePages.length === 0) {
      return {
        exitCode: 1,
        output: `Page not found: ${singlePage}\nTry using the slug (last part of the path), full path, or page ID.`,
      };
    }
  }

  // Apply min-importance filter
  if (minImportance !== undefined) {
    candidatePages = candidatePages.filter(p => (p.readerImportance ?? 0) >= minImportance);
  }

  // Sort by readerImportance descending
  candidatePages.sort((a, b) => (b.readerImportance ?? 0) - (a.readerImportance ?? 0));

  // Resolve MDX file paths and filter out pages without files
  const pagesWithFiles = candidatePages
    .map(p => ({ page: p, mdxPath: resolvePageMdxPath(p) }))
    .filter((pf): pf is { page: PageEntry; mdxPath: string } => pf.mdxPath !== null);

  console.log(`  ${pagesWithFiles.length} pages with MDX files (of ${candidatePages.length} candidates)`);

  // ── Step 3: Apply limits ──
  const maxByBudget = Math.floor(budgetLimit / ESTIMATED_COST_PER_PAGE);
  const effectiveLimit = Math.min(pageLimit, maxByBudget, pagesWithFiles.length);
  const selectedPages = pagesWithFiles.slice(0, effectiveLimit);

  const estimatedCost = selectedPages.length * ESTIMATED_COST_PER_PAGE;

  console.log(`  Selected ${selectedPages.length} pages (limit: ${pageLimit}, budget: \$${budgetLimit.toFixed(2)})`);
  console.log(`  Estimated cost: \$${estimatedCost.toFixed(2)}`);
  console.log('');

  // ── Step 4: Dry run or execute ──
  if (isDryRun) {
    return formatDryRunOutput(pagesWithFiles, selectedPages, estimatedCost, options);
  }

  // ── Live execution ──
  const client = createLlmClient();
  const allResults: PageSourcingResult[] = [];

  let totalConfirmed = 0;
  let totalContradicted = 0;
  let totalUnverifiable = 0;
  let totalOutdated = 0;
  let totalPartial = 0;
  let totalErrors = 0;
  let totalVerified = 0;
  let totalClaims = 0;
  let totalStorageErrors = 0;

  for (let i = 0; i < selectedPages.length; i++) {
    const { page, mdxPath } = selectedPages[i];
    const slug = extractPageSlug(page);
    console.log(`\x1b[1m[${i + 1}/${selectedPages.length}] ${page.title}\x1b[0m (${slug}, importance: ${page.readerImportance ?? 0})`);

    try {
      const pageResult = await processPage(page, mdxPath, client, kb);
      allResults.push(pageResult);

      totalClaims += pageResult.totalClaims;
      totalVerified += pageResult.verified;
      totalConfirmed += pageResult.confirmed;
      totalContradicted += pageResult.contradicted;
      totalUnverifiable += pageResult.unverifiable;
      totalOutdated += pageResult.outdated;
      totalPartial += pageResult.partial;
      totalErrors += pageResult.errors;
      totalStorageErrors += pageResult.storageErrors;

      const storageNote = pageResult.storageErrors > 0 ? `, \x1b[31m${pageResult.storageErrors} storage errors\x1b[0m` : '';
      console.log(`    Summary: ${pageResult.totalClaims} claims, ${pageResult.verified} verified, ${pageResult.errors} errors${storageNote}`);
      console.log('');
    } catch (e: unknown) {
      console.error(`    \x1b[31mFailed: ${e instanceof Error ? e.message : String(e)}\x1b[0m`);
      totalErrors++;
      console.log('');
    }
  }

  // Storage errors mean primary-data writes were lost — non-zero exit
  // even if no contradictions were found. Issue #4017.
  const exitCode = totalContradicted > 0 || totalStorageErrors > 0 ? 1 : 0;

  // ── Build summary output ──
  if (options.ci) {
    return {
      exitCode,
      output: JSON.stringify({
        pagesChecked: allResults.length,
        totalClaims,
        totalVerified,
        confirmed: totalConfirmed,
        contradicted: totalContradicted,
        unverifiable: totalUnverifiable,
        outdated: totalOutdated,
        partial: totalPartial,
        errors: totalErrors,
        storageErrors: totalStorageErrors,
        estimatedCost,
        pages: allResults.map(r => ({
          slug: r.pageSlug,
          title: r.pageTitle,
          claims: r.totalClaims,
          verified: r.verified,
          confirmed: r.confirmed,
          contradicted: r.contradicted,
          storageErrors: r.storageErrors,
        })),
      }),
    };
  }

  if (totalStorageErrors > 0) {
    console.error(`\n\x1b[31m${totalStorageErrors} storage error(s) occurred — verdicts were computed but not persisted to wiki-server. Re-run after the underlying issue is fixed.\x1b[0m`);
  }

  return {
    exitCode,
    output: formatSummaryOutput(allResults, {
      totalClaims,
      totalVerified,
      totalConfirmed,
      totalContradicted,
      totalUnverifiable,
      totalOutdated,
      totalPartial,
      totalErrors,
      totalStorageErrors,
      estimatedCost,
    }),
  };
}

// ── Output formatting ────────────────────────────────────────────────

function formatDryRunOutput(
  allPages: Array<{ page: PageEntry; mdxPath: string }>,
  selectedPages: Array<{ page: PageEntry; mdxPath: string }>,
  estimatedCost: number,
  options: WikiPagesOptions,
): CommandResult {
  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        totalAvailable: allPages.length,
        selected: selectedPages.length,
        estimatedCost,
        pages: selectedPages.map(({ page }) => ({
          slug: extractPageSlug(page),
          title: page.title,
          readerImportance: page.readerImportance,
          path: page.path,
        })),
      }),
    };
  }

  const lines: string[] = [];
  lines.push(`\x1b[1mDry run: ${selectedPages.length} of ${allPages.length} pages would be checked\x1b[0m`);
  lines.push(`Estimated cost: \$${estimatedCost.toFixed(2)}`);
  lines.push('');

  // Page list
  const header = `${'#'.padEnd(4)} ${'Slug'.padEnd(30)} ${'Importance'.padEnd(12)} Title`;
  lines.push(`\x1b[1m${header}\x1b[0m`);
  lines.push('-'.repeat(100));

  for (let i = 0; i < selectedPages.length; i++) {
    const { page } = selectedPages[i];
    const slug = extractPageSlug(page);
    const importance = String(page.readerImportance ?? 0);
    const title = truncate(page.title, 52, { ellipsis: '...' });
    lines.push(
      `${String(i + 1).padEnd(4)} ${slug.padEnd(30)} ${importance.padEnd(12)} ${title}`,
    );
  }

  if (selectedPages.length < allPages.length) {
    lines.push(`  ... and ${allPages.length - selectedPages.length} more pages available`);
  }

  lines.push('');
  lines.push('Use without --dry-run to run sourcing with LLM.');

  return { exitCode: 0, output: lines.join('\n') };
}

function formatSummaryOutput(
  results: PageSourcingResult[],
  totals: {
    totalClaims: number;
    totalVerified: number;
    totalConfirmed: number;
    totalContradicted: number;
    totalUnverifiable: number;
    totalOutdated: number;
    totalPartial: number;
    totalErrors: number;
    totalStorageErrors: number;
    estimatedCost: number;
  },
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('\x1b[1m=== Wiki Page Source-Check Summary ===\x1b[0m');
  lines.push(`Pages checked:    ${results.length}`);
  lines.push(`Total claims:     ${totals.totalClaims}`);
  lines.push(`Claims verified:  ${totals.totalVerified}`);
  lines.push(`Est. cost:        \$${totals.estimatedCost.toFixed(2)}`);
  lines.push('');
  lines.push(`\x1b[32mConfirmed:        ${totals.totalConfirmed}\x1b[0m`);
  lines.push(`\x1b[31mContradicted:     ${totals.totalContradicted}\x1b[0m`);
  lines.push(`\x1b[33mPartial:          ${totals.totalPartial}\x1b[0m`);
  lines.push(`\x1b[33mOutdated:         ${totals.totalOutdated}\x1b[0m`);
  lines.push(`Unverifiable:     ${totals.totalUnverifiable}`);
  lines.push(`Errors:           ${totals.totalErrors}`);
  if (totals.totalStorageErrors > 0) {
    lines.push(
      `\x1b[31mStorage errors:   ${totals.totalStorageErrors} verdict(s) computed but NOT persisted to wiki-server. Re-run after the underlying issue is fixed (issue #4017).\x1b[0m`,
    );
  }
  lines.push('');

  // Per-page breakdown
  if (results.length > 0) {
    lines.push('\x1b[1mPer-page breakdown:\x1b[0m');
    const pageHeader = `${'Page'.padEnd(30)} ${'Claims'.padEnd(8)} ${'OK'.padEnd(5)} ${'Bad'.padEnd(5)} ${'Stale'.padEnd(6)} ${'NoSrc'.padEnd(6)} ${'Err'.padEnd(5)}`;
    lines.push(pageHeader);
    lines.push('-'.repeat(75));

    for (const r of results) {
      const name = truncate(r.pageSlug, 30, { ellipsis: '...' });
      lines.push(
        `${name.padEnd(30)} ${String(r.totalClaims).padEnd(8)} ${String(r.confirmed).padEnd(5)} ${String(r.contradicted).padEnd(5)} ${String(r.outdated + r.staleClaims).padEnd(6)} ${String(r.unfootnotedClaims).padEnd(6)} ${String(r.errors).padEnd(5)}`,
      );
    }
  }

  // Show contradictions detail
  const contradictions = results.flatMap(r =>
    r.claimResults.filter(cr => cr.verdict === 'contradicted'),
  );
  if (contradictions.length > 0) {
    lines.push('');
    lines.push('\x1b[31m\x1b[1mContradictions found:\x1b[0m');
    for (const c of contradictions) {
      lines.push(`  - ${c.claimText.slice(0, 80)}`);
      lines.push(`    Source says: ${c.extractedValue.slice(0, 80)}`);
      lines.push(`    Reasoning: ${c.reasoning.slice(0, 80)}`);
    }
  }

  return lines.join('\n');
}

// ── Exports ─────────────────────────────────────────────────────────

export const commands = {
  default: sourcingWikiPagesCommand,
};

export function getHelp(): string {
  return `
Wiki Page Source-Check — verify prose claims in wiki pages against their cited sources

Usage:
  crux w sourcing-wiki-pages [options]             Check top pages by importance
  crux w sourcing-wiki-pages --page=anthropic      Check a specific page
  crux w sourcing-wiki-pages --dry-run             Preview what would be checked

Options:
  --limit=N               Max number of pages to process (default: 10)
  --budget=N              Max dollars to spend on LLM calls (default: 5.0)
  --page=<slug>           Process a single specific page
  --min-importance=N      Minimum readerImportance threshold
  --dry-run               Show what would be processed without running
  --ci                    JSON output for CI pipelines

For each page, the command:
  1. Extracts factual claims from MDX content using LLM
  2. Matches claims to footnote citations
  3. Cross-references claims against FactBase data
  4. Detects stale temporal references
  5. For sourced claims: fetches the source URL and verifies the claim via LLM
  6. Stores results in the wiki-server sourcing system

Record type: wiki-page
Record IDs: page slugs (e.g., "anthropic", "openai")
Field names: fn:<N> for sourced claims, _unfootnoted:<hash>, _cross-ref:<factId>, _stale:<hash>
  `.trim();
}
