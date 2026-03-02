/**
 * Batch retrofit of footnote references for pages with extracted claims.
 *
 * Scans all MDX pages for ones that have claims in the DB but are missing
 * inline footnote references, then runs the single-page retrofitPageRefs()
 * on each.
 *
 * Usage:
 *   pnpm crux claims retrofit-refs-batch                            # dry-run all
 *   pnpm crux claims retrofit-refs-batch --limit=10 --apply         # first 10
 *   pnpm crux claims retrofit-refs-batch --entity=metr --apply      # single entity
 *   pnpm crux claims retrofit-refs-batch --path=knowledge-base/     # directory filter
 */

import { readFileSync } from 'fs';
import { basename, relative } from 'path';
import { fileURLToPath } from 'url';
import { parseCliArgs, parseIntOpt } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { retrofitPageRefs, type RetrofitResult } from './retrofit-refs.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PageCandidate {
  pageId: string;
  filePath: string;
  relativePath: string;
  /** Number of existing rc-/cr- refs (0 for pages with no refs) */
  existingRefCount: number;
}

interface BatchResult {
  processed: number;
  skipped: number;
  errors: number;
  totalPlaced: number;
  totalUnmatched: number;
  totalRefsCreated: number;
  errorDetails: Array<{ pageId: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Discover eligible pages
// ---------------------------------------------------------------------------

const DB_REF_PATTERN = /\[\^(rc-[a-zA-Z0-9]+|cr-[a-zA-Z0-9]+)\]/g;

function discoverPages(options: {
  entity?: string;
  path?: string;
}): PageCandidate[] {
  const allFiles = findMdxFiles(CONTENT_DIR_ABS);
  const candidates: PageCandidate[] = [];

  for (const filePath of allFiles) {
    const pageId = basename(filePath, '.mdx');
    if (pageId === 'index') continue;

    const relativePath = relative(CONTENT_DIR_ABS, filePath);

    // Skip internal pages
    if (relativePath.startsWith('internal/')) continue;

    // Apply entity filter
    if (options.entity && pageId !== options.entity) continue;

    // Apply path filter
    if (options.path && !relativePath.startsWith(options.path)) continue;

    // Count existing DB-driven refs
    const content = readFileSync(filePath, 'utf-8');
    const matches = content.match(DB_REF_PATTERN);
    const existingRefCount = matches ? matches.length : 0;

    candidates.push({
      pageId,
      filePath,
      relativePath,
      existingRefCount,
    });
  }

  // Sort: pages with NO refs first, then by name
  candidates.sort((a, b) => {
    if (a.existingRefCount === 0 && b.existingRefCount > 0) return -1;
    if (a.existingRefCount > 0 && b.existingRefCount === 0) return 1;
    return a.pageId.localeCompare(b.pageId);
  });

  return candidates;
}

// ---------------------------------------------------------------------------
// Batch execution
// ---------------------------------------------------------------------------

async function runBatch(
  candidates: PageCandidate[],
  apply: boolean,
  model: string,
  maxClaimsPerSection: number,
  c: ReturnType<typeof getColors>,
): Promise<BatchResult> {
  const result: BatchResult = {
    processed: 0,
    skipped: 0,
    errors: 0,
    totalPlaced: 0,
    totalUnmatched: 0,
    totalRefsCreated: 0,
    errorDetails: [],
  };

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const progress = `[${i + 1}/${candidates.length}]`;

    try {
      const pageResult = await retrofitPageRefs(candidate.pageId, {
        apply,
        model,
        maxClaimsPerSection,
      });

      if (pageResult.totalClaims === 0) {
        result.skipped++;
        console.log(
          `  ${progress} ${c.dim}${candidate.pageId}${c.reset} — no claims (skipped)`,
        );
        continue;
      }

      if (pageResult.eligibleClaims === 0) {
        result.skipped++;
        console.log(
          `  ${progress} ${c.dim}${candidate.pageId}${c.reset} — all claims already referenced (skipped)`,
        );
        continue;
      }

      if (pageResult.placed === 0) {
        result.skipped++;
        console.log(
          `  ${progress} ${c.dim}${candidate.pageId}${c.reset} — ${pageResult.eligibleClaims} eligible, 0 placed (skipped)`,
        );
        continue;
      }

      result.processed++;
      result.totalPlaced += pageResult.placed;
      result.totalUnmatched += pageResult.unmatched;
      result.totalRefsCreated += pageResult.refsCreated;

      const refTag = `${c.green}${pageResult.placed} placed${c.reset}`;
      const existingTag = candidate.existingRefCount > 0
        ? ` ${c.dim}(${candidate.existingRefCount} existing)${c.reset}`
        : '';

      console.log(
        `  ${progress} ${c.bold}${candidate.pageId}${c.reset} — ${refTag}${existingTag}`,
      );
    } catch (err) {
      result.errors++;
      const errorMessage = err instanceof Error ? err.message : String(err);
      result.errorDetails.push({ pageId: candidate.pageId, error: errorMessage });
      console.log(
        `  ${progress} ${c.red}${candidate.pageId}${c.reset} — ERROR: ${errorMessage.slice(0, 100)}`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const c = getColors(false);
  const apply = args.apply === true;
  const limit = parseIntOpt(args.limit, 0); // 0 = no limit
  const entityFilter = typeof args.entity === 'string' ? args.entity : undefined;
  const pathFilter = typeof args.path === 'string' ? args.path : undefined;
  const model = typeof args.model === 'string' ? args.model : DEFAULT_CITATION_MODEL;
  const maxClaims = parseIntOpt(args['max-claims'], 15);

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(
      `${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`,
    );
    process.exit(1);
  }

  console.log(
    `\n${c.bold}${c.blue}Retrofit References (Batch)${c.reset}${apply ? '' : ` ${c.dim}(dry-run)${c.reset}`}\n`,
  );

  console.log(`${c.dim}Scanning pages...${c.reset}`);
  const candidates = discoverPages({ entity: entityFilter, path: pathFilter });

  if (candidates.length === 0) {
    console.log(`${c.yellow}No eligible pages found.${c.reset}`);
    if (entityFilter) console.log(`  Entity filter: ${entityFilter}`);
    if (pathFilter) console.log(`  Path filter: ${pathFilter}`);
    return;
  }

  // Apply limit
  const toProcess = limit > 0 ? candidates.slice(0, limit) : candidates;
  const limited = limit > 0 && candidates.length > limit;

  // Summary header
  const noRefCount = candidates.filter((c) => c.existingRefCount === 0).length;
  const withRefCount = candidates.length - noRefCount;
  console.log(`  Found ${c.bold}${candidates.length}${c.reset} pages (${noRefCount} without refs, ${withRefCount} with existing refs)`);
  if (limited) {
    console.log(`  Processing first ${c.bold}${toProcess.length}${c.reset} (--limit=${limit})`);
  }
  if (entityFilter) console.log(`  Entity filter: ${entityFilter}`);
  if (pathFilter) console.log(`  Path filter: ${pathFilter}`);
  console.log();

  const result = await runBatch(toProcess, apply, model, maxClaims, c);

  // Summary
  console.log(`\n${c.bold}Summary:${c.reset}`);
  console.log(`  Pages processed:    ${c.bold}${result.processed}${c.reset}`);
  console.log(`  Pages skipped:      ${result.skipped}`);
  console.log(`  Pages errored:      ${result.errors > 0 ? `${c.red}${result.errors}${c.reset}` : '0'}`);
  console.log(`  Total refs placed:  ${c.green}${result.totalPlaced}${c.reset}`);
  console.log(`  Total unmatched:    ${result.totalUnmatched}`);

  if (result.errorDetails.length > 0) {
    console.log(`\n${c.red}Errors:${c.reset}`);
    for (const { pageId, error } of result.errorDetails) {
      console.log(`  ${c.red}${pageId}${c.reset}: ${error}`);
    }
  }

  if (!apply) {
    console.log(`\n${c.yellow}Dry run — no changes written.${c.reset}`);
    console.log(`Run with ${c.bold}--apply${c.reset} to write changes.\n`);
  } else {
    console.log(`\n${c.green}Applied!${c.reset}`);
    console.log(`  ${result.totalRefsCreated} page_citations created\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Batch retrofit refs failed:', err);
    process.exit(1);
  });
}
