/**
 * Batch migration of numbered footnotes to DB-driven references.
 *
 * Scans all MDX pages for [^N] footnotes and migrates each page using
 * the single-page migratePageFootnotes() function from migrate-footnotes.ts.
 *
 * Usage:
 *   pnpm crux claims migrate-footnotes-batch                        # dry-run all pages
 *   pnpm crux claims migrate-footnotes-batch --batch-size=50        # process 50 pages
 *   pnpm crux claims migrate-footnotes-batch --entity=kalshi        # single entity
 *   pnpm crux claims migrate-footnotes-batch --path=knowledge-base/ # directory filter
 *   pnpm crux claims migrate-footnotes-batch --apply                # write changes
 */

import { readFileSync } from 'fs';
import { basename, relative } from 'path';
import { fileURLToPath } from 'url';
import { parseCliArgs, parseIntOpt } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { migratePageFootnotes } from './migrate-footnotes.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PageCandidate {
  pageId: string;
  filePath: string;
  /** Relative path from content/docs/ for display and path filtering */
  relativePath: string;
  footnoteCount: number;
}

interface BatchResult {
  processed: number;
  skipped: number;
  errors: number;
  totalFootnotes: number;
  totalClaimRefs: number;
  totalCitations: number;
  errorDetails: Array<{ pageId: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Discover pages with footnotes
// ---------------------------------------------------------------------------

const NUMBERED_FOOTNOTE_RE = /\[\^\d+\]/g;

function discoverPages(options: {
  entity?: string;
  path?: string;
}): PageCandidate[] {
  const allFiles = findMdxFiles(CONTENT_DIR_ABS);
  const candidates: PageCandidate[] = [];

  for (const filePath of allFiles) {
    const pageId = basename(filePath, '.mdx');
    if (pageId === 'index') continue; // Skip index pages

    const relativePath = relative(CONTENT_DIR_ABS, filePath);

    // Apply entity filter
    if (options.entity && pageId !== options.entity) continue;

    // Apply path filter (match against relative path from content/docs/)
    if (options.path && !relativePath.startsWith(options.path)) continue;

    // Check for numbered footnotes
    const content = readFileSync(filePath, 'utf-8');
    const matches = content.match(NUMBERED_FOOTNOTE_RE);
    if (!matches || matches.length === 0) continue;

    // Count unique footnote numbers (not just inline refs)
    const footnoteDefCount = (content.match(/^\[\^\d+\]:/gm) || []).length;
    if (footnoteDefCount === 0) continue;

    candidates.push({
      pageId,
      filePath,
      relativePath,
      footnoteCount: footnoteDefCount,
    });
  }

  // Sort by footnote count descending (process biggest first for visibility)
  candidates.sort((a, b) => b.footnoteCount - a.footnoteCount);

  return candidates;
}

// ---------------------------------------------------------------------------
// Batch migration
// ---------------------------------------------------------------------------

async function runBatch(
  candidates: PageCandidate[],
  apply: boolean,
  c: ReturnType<typeof getColors>,
): Promise<BatchResult> {
  const result: BatchResult = {
    processed: 0,
    skipped: 0,
    errors: 0,
    totalFootnotes: 0,
    totalClaimRefs: 0,
    totalCitations: 0,
    errorDetails: [],
  };

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const progress = `[${i + 1}/${candidates.length}]`;

    try {
      const migrationResult = await migratePageFootnotes(candidate.pageId, { apply });

      if (migrationResult.totalFootnotes === 0) {
        result.skipped++;
        console.log(
          `  ${progress} ${c.dim}${candidate.pageId}${c.reset} — no footnotes (skipped)`,
        );
        continue;
      }

      result.processed++;
      result.totalFootnotes += migrationResult.totalFootnotes;
      result.totalClaimRefs += migrationResult.claimRefs;
      result.totalCitations += migrationResult.citations;

      const claimTag = migrationResult.claimRefs > 0
        ? `${c.green}${migrationResult.claimRefs} claim${c.reset}`
        : '';
      const citeTag = migrationResult.citations > 0
        ? `${c.cyan}${migrationResult.citations} cite${c.reset}`
        : '';
      const tags = [claimTag, citeTag].filter(Boolean).join(', ');

      console.log(
        `  ${progress} ${c.bold}${candidate.pageId}${c.reset} — ${migrationResult.totalFootnotes} footnotes (${tags})`,
      );
    } catch (err) {
      result.errors++;
      const errorMessage = err instanceof Error ? err.message : String(err);
      result.errorDetails.push({ pageId: candidate.pageId, error: errorMessage });
      console.log(
        `  ${progress} ${c.red}${candidate.pageId}${c.reset} — ERROR: ${errorMessage}`,
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
  const batchSize = parseIntOpt(args['batch-size'], 0); // 0 = no limit
  const entityFilter = typeof args.entity === 'string' ? args.entity : undefined;
  const pathFilter = typeof args.path === 'string' ? args.path : undefined;

  // Check wiki server availability
  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(
      `${c.red}Wiki server not available. Set LONGTERMWIKI_SERVER_URL and LONGTERMWIKI_SERVER_API_KEY.${c.reset}`,
    );
    process.exit(1);
  }

  // Discover pages
  console.log(`\n${c.bold}${c.blue}Footnote Migration (Batch)${c.reset}${apply ? '' : ` ${c.dim}(dry-run)${c.reset}`}\n`);

  console.log(`${c.dim}Scanning pages for numbered footnotes...${c.reset}`);
  const candidates = discoverPages({ entity: entityFilter, path: pathFilter });

  if (candidates.length === 0) {
    console.log(`${c.yellow}No pages with numbered footnotes found.${c.reset}`);
    if (entityFilter) console.log(`  Entity filter: ${entityFilter}`);
    if (pathFilter) console.log(`  Path filter: ${pathFilter}`);
    return;
  }

  // Apply batch size limit
  const toProcess = batchSize > 0 ? candidates.slice(0, batchSize) : candidates;
  const limited = batchSize > 0 && candidates.length > batchSize;

  // Summary header
  console.log(`  Found ${c.bold}${candidates.length}${c.reset} pages with numbered footnotes`);
  if (limited) {
    console.log(`  Processing first ${c.bold}${toProcess.length}${c.reset} (--batch-size=${batchSize})`);
  }
  if (entityFilter) console.log(`  Entity filter: ${entityFilter}`);
  if (pathFilter) console.log(`  Path filter: ${pathFilter}`);
  console.log();

  // Run batch
  const result = await runBatch(toProcess, apply, c);

  // Summary
  console.log(`\n${c.bold}Summary:${c.reset}`);
  console.log(`  Pages processed:   ${c.bold}${result.processed}${c.reset}`);
  console.log(`  Pages skipped:     ${result.skipped}`);
  console.log(`  Pages errored:     ${result.errors > 0 ? `${c.red}${result.errors}${c.reset}` : '0'}`);
  console.log(`  Total footnotes:   ${c.bold}${result.totalFootnotes}${c.reset}`);
  console.log(`  Claim-backed refs: ${c.green}${result.totalClaimRefs}${c.reset}`);
  console.log(`  Regular citations: ${c.cyan}${result.totalCitations}${c.reset}`);

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
    console.log(`  ${result.totalClaimRefs} claim_page_references created`);
    console.log(`  ${result.totalCitations} page_citations created\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Batch footnote migration failed:', err);
    process.exit(1);
  });
}
