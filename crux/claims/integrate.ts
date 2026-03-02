/**
 * Claims Integration — single command to connect claims to page content.
 *
 * This bridges the gap between the page authoring pipeline (which produces
 * [^rc-XXXX] footnotes) and the claims system (which stores verified facts).
 *
 * Steps:
 *   1. Extract claims from the page (if not already done)
 *   2. Migrate [^rc-XXXX] → [^cr-XXXX] for claim-backed footnotes + create claim_page_references
 *
 * Note: Steps 2 (link citation_quotes) and 4 (propagate verdicts) were removed in #1310.
 * Claims are now the single source of truth.
 *
 * Usage:
 *   pnpm crux claims integrate <page-id>           # dry-run
 *   pnpm crux claims integrate <page-id> --apply    # apply changes
 *   pnpm crux claims integrate <page-id> --skip-extract  # skip extraction (claims already exist)
 *   pnpm crux claims integrate <page-id> --force    # re-extract even if claims exist
 */

import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { findPageFile } from '../lib/file-utils.ts';
import {
  getClaimsByEntity,
} from '../lib/wiki-server/claims.ts';
import { getQuotesByPage } from '../lib/wiki-server/citations.ts';
import { createClaimReference } from '../lib/wiki-server/references.ts';
import type { ClaimPageReferenceInsert } from '../../apps/wiki-server/src/api-types.ts';

/** Generate a short, stable reference ID (cr- or rc- prefix) from a hash of the input data. */
function generateReferenceId(prefix: 'cr' | 'rc', data: string, existingIds: Set<string>): string {
  const hash = createHash('sha256').update(data).digest('hex');
  for (let offset = 0; offset <= hash.length - 4; offset++) {
    const candidate = `${prefix}-${hash.slice(offset, offset + 4)}`;
    if (!existingIds.has(candidate)) {
      existingIds.add(candidate);
      return candidate;
    }
  }
  const fallback = `${prefix}-${hash.slice(0, 8)}`;
  existingIds.add(fallback);
  return fallback;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IntegrationResult {
  pageId: string;
  steps: StepResult[];
  summary: {
    claimsTotal: number;
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

// Step 2 (link citation_quotes to claims) was removed in #1310.
// Claims are now the single source of truth — no backward linking needed.

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
  const quotesResult = await getQuotesByPage(pageId, 500);
  const quotes = quotesResult.ok ? quotesResult.data.quotes : [];
  const linkedQuotes = quotes.filter((q: { claimId: number | null }) => q.claimId !== null);

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

// Step 4 (propagate claim verdicts to citation_quotes) was removed in #1310.
// Claims are now the single source of truth — no backward propagation needed.

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
        footnotesConverted: 0,
        claimRefsCreated: 0,
      },
    };
  }

  // Step 2: Convert rc- footnotes to cr-
  const convertResult = await convertFootnotes(pageId, apply);
  steps.push(convertResult);

  return {
    pageId,
    steps,
    summary: {
      claimsTotal: claimResult.claimCount,
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
  console.log(`  Footnotes converted: ${result.summary.footnotesConverted}`);
  console.log(`  Claim refs created: ${result.summary.claimRefsCreated}`);

  if (!apply && result.summary.footnotesConverted > 0) {
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
