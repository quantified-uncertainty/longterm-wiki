/**
 * Claims Integration — single command to connect claims to page content.
 *
 * This bridges the gap between the page authoring pipeline (which produces
 * [^rc-XXXX] footnotes) and the claims system (which stores verified facts).
 *
 * Steps:
 *   1. Extract claims from the page (if not already done)
 *   2. Link citation_quotes to claims
 *   3. Migrate [^rc-XXXX] → [^cr-XXXX] for claim-backed footnotes
 *   4. Create claim_page_references in DB
 *
 * Usage:
 *   pnpm crux claims integrate <page-id>           # dry-run
 *   pnpm crux claims integrate <page-id> --apply    # apply changes
 *   pnpm crux claims integrate <page-id> --skip-extract  # skip extraction (claims already exist)
 *   pnpm crux claims integrate <page-id> --force    # re-extract even if claims exist
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable, apiRequest } from '../lib/wiki-server/client.ts';
import { findPageFile } from '../lib/file-utils.ts';
import {
  getClaimsByEntity,
  addClaimPageReferencesBatch,
} from '../lib/wiki-server/claims.ts';
import {
  linkCitationsToClaimsBatch,
  propagateClaimVerdictsToPage,
} from '../lib/wiki-server/citations.ts';
import { createClaimReference } from '../lib/wiki-server/references.ts';
import { generateReferenceId } from './migrate-footnotes.ts';
import type { ClaimPageReferenceInsert } from '../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CitationQuoteRow {
  id: number;
  pageId: string;
  footnote: number | null;
  claimText: string;
  claimContext: string | null;
  sourceQuote: string | null;
  url: string | null;
  resourceId: string | null;
  accuracyVerdict: string | null;
  claimId: number | null;
}

interface IntegrationResult {
  pageId: string;
  steps: StepResult[];
  summary: {
    claimsTotal: number;
    quotesTotal: number;
    quotesLinked: number;
    footnotesConverted: number;
    claimRefsCreated: number;
  };
}

interface StepResult {
  name: string;
  status: 'ok' | 'skipped' | 'error';
  message: string;
}

// ---------------------------------------------------------------------------
// Fetch citation_quotes for a page
// ---------------------------------------------------------------------------

async function fetchQuotesForPage(pageId: string): Promise<CitationQuoteRow[]> {
  const result = await apiRequest<{ quotes: CitationQuoteRow[] }>(
    'GET',
    `/api/citations/quotes?page_id=${encodeURIComponent(pageId)}&limit=500`,
  );
  if (!result.ok) return [];
  return result.data.quotes;
}

// ---------------------------------------------------------------------------
// Step 1: Ensure claims exist for the page
// ---------------------------------------------------------------------------

async function ensureClaims(
  pageId: string,
  options: { skipExtract: boolean; force: boolean },
): Promise<StepResult & { claimCount: number }> {
  const existingResult = await getClaimsByEntity(pageId);
  const existingCount = existingResult.ok ? existingResult.data.claims.length : 0;

  if (existingCount > 0 && !options.force) {
    return {
      name: 'ensure-claims',
      status: 'ok',
      message: `${existingCount} claims already exist`,
      claimCount: existingCount,
    };
  }

  if (options.skipExtract) {
    return {
      name: 'ensure-claims',
      status: existingCount > 0 ? 'ok' : 'skipped',
      message: existingCount > 0
        ? `${existingCount} claims exist (--skip-extract)`
        : 'No claims found and --skip-extract specified',
      claimCount: existingCount,
    };
  }

  // Claims need extraction — tell the user to run the pipeline
  return {
    name: 'ensure-claims',
    status: existingCount > 0 ? 'ok' : 'error',
    message: existingCount > 0
      ? `${existingCount} claims exist`
      : 'No claims found. Run `crux claims pipeline ' + pageId + '` first to extract claims.',
    claimCount: existingCount,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Link citation_quotes to claims
// ---------------------------------------------------------------------------

async function linkQuotesToClaims(
  pageId: string,
  apply: boolean,
): Promise<StepResult & { quotesTotal: number; linked: number }> {
  const quotes = await fetchQuotesForPage(pageId);
  if (quotes.length === 0) {
    return {
      name: 'link-quotes',
      status: 'skipped',
      message: 'No citation_quotes found for this page',
      quotesTotal: 0,
      linked: 0,
    };
  }

  const unlinked = quotes.filter(q => q.claimId === null);
  const alreadyLinked = quotes.filter(q => q.claimId !== null);

  if (unlinked.length === 0) {
    return {
      name: 'link-quotes',
      status: 'ok',
      message: `All ${quotes.length} quotes already linked to claims`,
      quotesTotal: quotes.length,
      linked: alreadyLinked.length,
    };
  }

  // Get claims for this entity to find matches
  const claimsResult = await getClaimsByEntity(pageId);
  if (!claimsResult.ok || claimsResult.data.claims.length === 0) {
    return {
      name: 'link-quotes',
      status: 'skipped',
      message: `${unlinked.length} unlinked quotes, but no claims to link to`,
      quotesTotal: quotes.length,
      linked: alreadyLinked.length,
    };
  }

  // Match unlinked quotes to claims by text similarity
  const claims = claimsResult.data.claims;
  const linkItems: Array<{ quoteId: number; claimId: number }> = [];

  for (const quote of unlinked) {
    const quoteLower = quote.claimText.toLowerCase().trim();
    // Try exact match first, then substring match
    let bestClaim = claims.find(c =>
      c.claimText.toLowerCase().trim() === quoteLower
    );
    if (!bestClaim) {
      // Try substring containment
      bestClaim = claims.find(c =>
        quoteLower.includes(c.claimText.toLowerCase().trim()) ||
        c.claimText.toLowerCase().trim().includes(quoteLower)
      );
    }
    if (bestClaim) {
      linkItems.push({ quoteId: quote.id, claimId: bestClaim.id });
    }
  }

  if (linkItems.length === 0) {
    return {
      name: 'link-quotes',
      status: 'ok',
      message: `${unlinked.length} unlinked quotes, no text matches found`,
      quotesTotal: quotes.length,
      linked: alreadyLinked.length,
    };
  }

  if (apply) {
    const result = await linkCitationsToClaimsBatch(linkItems);
    if (result.ok) {
      return {
        name: 'link-quotes',
        status: 'ok',
        message: `Linked ${result.data.linked} quotes to claims (${alreadyLinked.length} already linked)`,
        quotesTotal: quotes.length,
        linked: alreadyLinked.length + result.data.linked,
      };
    }
  }

  return {
    name: 'link-quotes',
    status: 'ok',
    message: `Would link ${linkItems.length} quotes to claims (${alreadyLinked.length} already linked)`,
    quotesTotal: quotes.length,
    linked: alreadyLinked.length,
  };
}

// ---------------------------------------------------------------------------
// Step 3: Convert rc- footnotes to cr- where claims are linked
// ---------------------------------------------------------------------------

async function convertFootnotes(
  pageId: string,
  apply: boolean,
): Promise<StepResult & { converted: number; refsCreated: number }> {
  const filePath = findPageFile(pageId);
  if (!filePath) {
    return {
      name: 'convert-footnotes',
      status: 'error',
      message: `Page file not found for: ${pageId}`,
      converted: 0,
      refsCreated: 0,
    };
  }

  const content = readFileSync(filePath, 'utf-8');

  // Find all [^rc-XXXX] references in the content
  const rcPattern = /\[\^(rc-[a-f0-9]+)\]/g;
  const rcRefs = new Set<string>();
  let match;
  while ((match = rcPattern.exec(content)) !== null) {
    rcRefs.add(match[1]);
  }

  if (rcRefs.size === 0) {
    return {
      name: 'convert-footnotes',
      status: 'skipped',
      message: 'No [^rc-XXXX] footnotes found in page',
      converted: 0,
      refsCreated: 0,
    };
  }

  // Fetch quotes with linked claims
  const quotes = await fetchQuotesForPage(pageId);
  const linkedQuotes = quotes.filter(q => q.claimId !== null);

  if (linkedQuotes.length === 0) {
    return {
      name: 'convert-footnotes',
      status: 'skipped',
      message: `${rcRefs.size} rc- footnotes found but no linked quotes to convert`,
      converted: 0,
      refsCreated: 0,
    };
  }

  // Map footnote numbers to rc- reference IDs by scanning definition lines
  const rcDefPattern = /^\[\^(rc-[a-f0-9]+)\]:\s*(.*)/gm;
  const rcDefMap = new Map<string, { refId: string; rawText: string }>();
  let defMatch;
  while ((defMatch = rcDefPattern.exec(content)) !== null) {
    rcDefMap.set(defMatch[1], { refId: defMatch[1], rawText: defMatch[2] });
  }

  // Match linked quotes to rc- footnotes by URL overlap
  const conversions: Array<{
    rcRefId: string;
    crRefId: string;
    claimId: number;
    footnoteNum: number | null;
  }> = [];

  const usedIds = new Set<string>();
  // Collect existing cr- refs
  const crPattern = /\[\^(cr-[a-f0-9]+)\]/g;
  let crMatch;
  while ((crMatch = crPattern.exec(content)) !== null) {
    usedIds.add(crMatch[1]);
  }

  for (const quote of linkedQuotes) {
    if (quote.footnote === null) continue;

    // Find the rc- ref that corresponds to this footnote number
    // We need to match by URL or text content
    for (const [rcId, def] of rcDefMap) {
      const defUrl = def.rawText.match(/(https?:\/\/[^\s,)"']+)/)?.[1];
      const quoteUrl = quote.url;

      // Match by URL if both have one
      const urlMatch = defUrl && quoteUrl && (
        defUrl === quoteUrl ||
        defUrl.replace(/\/$/, '') === quoteUrl.replace(/\/$/, '')
      );

      // Match by text similarity as fallback
      const textMatch = !urlMatch && quote.claimText &&
        def.rawText.toLowerCase().includes(quote.claimText.toLowerCase().slice(0, 50));

      if (urlMatch || textMatch) {
        const crRefId = generateReferenceId(
          'cr',
          `claim:${quote.claimId}:${pageId}:${quote.footnote}`,
          usedIds,
        );
        conversions.push({
          rcRefId: rcId,
          crRefId,
          claimId: quote.claimId!,
          footnoteNum: quote.footnote,
        });
        rcDefMap.delete(rcId); // Don't match this again
        break;
      }
    }
  }

  if (conversions.length === 0) {
    return {
      name: 'convert-footnotes',
      status: 'ok',
      message: `${rcRefs.size} rc- footnotes, ${linkedQuotes.length} linked quotes, but no matches found`,
      converted: 0,
      refsCreated: 0,
    };
  }

  let refsCreated = 0;

  if (apply) {
    // Rewrite MDX: replace [^rc-XXXX] with [^cr-XXXX]
    let modified = content;
    for (const conv of conversions) {
      // Replace inline refs
      modified = modified.replaceAll(`[^${conv.rcRefId}]`, `[^${conv.crRefId}]`);
    }
    writeFileSync(filePath, modified, 'utf-8');

    // Create claim_page_references in DB
    for (const conv of conversions) {
      const insert: ClaimPageReferenceInsert = {
        claimId: conv.claimId,
        pageId,
        footnote: conv.footnoteNum,
        referenceId: conv.crRefId,
      };
      const result = await createClaimReference(insert);
      if (result.ok) {
        refsCreated++;
      }
    }
  }

  return {
    name: 'convert-footnotes',
    status: 'ok',
    message: apply
      ? `Converted ${conversions.length} footnotes (rc → cr), created ${refsCreated} claim refs`
      : `Would convert ${conversions.length} footnotes (rc → cr)`,
    converted: conversions.length,
    refsCreated,
  };
}

// ---------------------------------------------------------------------------
// Step 4: Propagate claim verdicts
// ---------------------------------------------------------------------------

async function propagateVerdicts(
  pageId: string,
  apply: boolean,
): Promise<StepResult> {
  if (!apply) {
    return {
      name: 'propagate-verdicts',
      status: 'skipped',
      message: 'Skipped in dry-run',
    };
  }

  const result = await propagateClaimVerdictsToPage(pageId);
  if (result.ok) {
    return {
      name: 'propagate-verdicts',
      status: 'ok',
      message: `Propagated verdicts: ${result.data.updated ?? 0} quotes updated`,
    };
  }
  return {
    name: 'propagate-verdicts',
    status: 'error',
    message: `Failed to propagate: ${(result as { message?: string }).message ?? 'unknown error'}`,
  };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function integrateClaims(
  pageId: string,
  options: { apply?: boolean; skipExtract?: boolean; force?: boolean } = {},
): Promise<IntegrationResult> {
  const { apply = false, skipExtract = false, force = false } = options;

  const steps: StepResult[] = [];

  // Step 1: Ensure claims exist
  const claimResult = await ensureClaims(pageId, { skipExtract, force });
  steps.push(claimResult);

  if (claimResult.claimCount === 0 && claimResult.status === 'error') {
    return {
      pageId,
      steps,
      summary: {
        claimsTotal: 0,
        quotesTotal: 0,
        quotesLinked: 0,
        footnotesConverted: 0,
        claimRefsCreated: 0,
      },
    };
  }

  // Step 2: Link citation_quotes to claims
  const linkResult = await linkQuotesToClaims(pageId, apply);
  steps.push(linkResult);

  // Step 3: Convert rc- footnotes to cr-
  const convertResult = await convertFootnotes(pageId, apply);
  steps.push(convertResult);

  // Step 4: Propagate verdicts
  const verdictResult = await propagateVerdicts(pageId, apply);
  steps.push(verdictResult);

  return {
    pageId,
    steps,
    summary: {
      claimsTotal: claimResult.claimCount,
      quotesTotal: linkResult.quotesTotal,
      quotesLinked: linkResult.linked,
      footnotesConverted: convertResult.converted,
      claimRefsCreated: convertResult.refsCreated,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];
  const apply = args.apply === true;
  const skipExtract = args['skip-extract'] === true;
  const force = args.force === true;

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error(`  Usage: pnpm crux claims integrate <page-id>`);
    console.error(`  Usage: pnpm crux claims integrate <page-id> --apply`);
    console.error(`  Usage: pnpm crux claims integrate <page-id> --skip-extract`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available.${c.reset}`);
    process.exit(1);
  }

  console.log(
    `\n${c.bold}${c.blue}Claims Integration: ${pageId}${c.reset}${apply ? '' : ` ${c.dim}(dry-run)${c.reset}`}\n`,
  );

  const result = await integrateClaims(pageId, { apply, skipExtract, force });

  // Print steps
  for (const step of result.steps) {
    const icon = step.status === 'ok'
      ? `${c.green}✓${c.reset}`
      : step.status === 'skipped'
        ? `${c.yellow}–${c.reset}`
        : `${c.red}✗${c.reset}`;
    console.log(`  ${icon} ${c.bold}${step.name}${c.reset}: ${step.message}`);
  }

  // Summary
  console.log();
  console.log(`${c.bold}Summary${c.reset}`);
  console.log(`  Claims:             ${result.summary.claimsTotal}`);
  console.log(`  Citation quotes:    ${result.summary.quotesTotal}`);
  console.log(`  Quotes linked:      ${result.summary.quotesLinked}`);
  console.log(`  Footnotes converted: ${result.summary.footnotesConverted}`);
  console.log(`  Claim refs created: ${result.summary.claimRefsCreated}`);

  if (!apply && (result.summary.footnotesConverted > 0 || result.summary.quotesLinked > 0)) {
    console.log(`\n${c.yellow}Dry run — no changes written. Use --apply to integrate.${c.reset}`);
  }
  console.log();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Claims integration failed:', err);
    process.exit(1);
  });
}
