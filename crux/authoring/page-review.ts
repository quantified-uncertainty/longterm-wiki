/**
 * Standalone Adversarial Review CLI
 *
 * Runs the adversarial review phase on one or more pages without running
 * the full improve pipeline. Useful as a cheap quality triage (~$0.50/page)
 * before deciding whether to run standard/deep improvement.
 *
 * Usage:
 *   pnpm crux content review <page-id>
 *   pnpm crux content review <page-id> --model=claude-sonnet-4-20250514
 *   pnpm crux content review --batch --limit=10
 */

import fs from 'fs';
import { parseCliArgs } from '../lib/cli.ts';
import { loadPages, findPage, getFilePath } from './page-improver/utils.ts';
import { adversarialReviewPhase } from './page-improver/phases/adversarial-review.ts';
import type { PageData, AdversarialReviewResult, PipelineOptions } from './page-improver/types.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function printReview(page: PageData, review: AdversarialReviewResult): void {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`  ${page.title} (${page.id})`);
  console.log(`${'━'.repeat(60)}\n`);

  if (review.gaps.length === 0) {
    console.log('  No gaps found — page meets quality standards.\n');
    return;
  }

  // Group by type
  const byType = new Map<string, typeof review.gaps>();
  for (const gap of review.gaps) {
    const list = byType.get(gap.type) ?? [];
    list.push(gap);
    byType.set(gap.type, list);
  }

  for (const [type, gaps] of byType) {
    console.log(`  [${type}] (${gaps.length})`);
    for (const gap of gaps) {
      const action = gap.actionType === 're-research' ? ' → re-research' : gap.actionType === 'edit' ? ' → edit' : '';
      console.log(`    - ${gap.description}${action}`);
      if (gap.reResearchQuery) {
        console.log(`      query: "${gap.reResearchQuery}"`);
      }
    }
    console.log();
  }

  if (review.overallAssessment) {
    console.log(`  Assessment: ${review.overallAssessment}\n`);
  }

  if (review.reResearchQueries.length > 0) {
    console.log(`  Re-research queries (${review.reResearchQueries.length}):`);
    for (const q of review.reResearchQueries) {
      console.log(`    - ${q}`);
    }
    console.log();
  }
}

function printBatchSummary(results: Array<{ page: PageData; review: AdversarialReviewResult }>): void {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`  Batch Summary`);
  console.log(`${'━'.repeat(60)}\n`);

  // Sort by gap count descending
  const sorted = [...results].sort((a, b) => b.review.gaps.length - a.review.gaps.length);

  console.log('  Page'.padEnd(40) + 'Gaps'.padEnd(8) + 'Re-research');
  console.log('  ' + '─'.repeat(56));

  for (const { page, review } of sorted) {
    const name = page.title.length > 35 ? page.title.slice(0, 32) + '...' : page.title;
    const gaps = String(review.gaps.length).padEnd(8);
    const reresearch = review.needsReResearch ? 'yes' : 'no';
    console.log(`  ${name.padEnd(38)}${gaps}${reresearch}`);
  }

  const totalGaps = results.reduce((n, r) => n + r.review.gaps.length, 0);
  const needsResearch = results.filter(r => r.review.needsReResearch).length;
  console.log(`\n  Total: ${totalGaps} gaps across ${results.length} pages (${needsResearch} need re-research)\n`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const pageId = args._positional[0];
  const batch = args.batch === true;
  const limit = typeof args.limit === 'string' ? parseInt(args.limit, 10) : 10;
  const model = typeof args.model === 'string' ? args.model : undefined;

  if (args.help === true) {
    console.log(`
Usage:
  pnpm crux content review <page-id>          Review a single page
  pnpm crux content review --batch --limit=10 Review lowest-quality pages

Options:
  --model=<m>    LLM model for review (default: sonnet)
  --batch        Review multiple pages (lowest quality first)
  --limit=<n>    Number of pages in batch mode (default: 10)
  --help         Show this help
`);
    process.exit(0);
  }

  if (!pageId && !batch) {
    console.error('Error: provide a <page-id> or use --batch');
    process.exit(1);
  }

  const pages = loadPages();
  const options: PipelineOptions = {};
  if (model) options.adversarialModel = model;

  if (batch) {
    // Sort by quality ascending (lowest quality first), filter out pages without quality
    const scored = pages
      .filter(p => typeof p.quality === 'number')
      .sort((a, b) => (a.quality ?? 99) - (b.quality ?? 99))
      .slice(0, limit);

    console.log(`Reviewing ${scored.length} pages (lowest quality first)...\n`);

    const results: Array<{ page: PageData; review: AdversarialReviewResult }> = [];
    for (const page of scored) {
      const filePath = getFilePath(page.path);
      if (!fs.existsSync(filePath)) {
        console.log(`  Skipping ${page.id} — file not found`);
        continue;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      try {
        const review = await adversarialReviewPhase(page, content, options);
        results.push({ page, review });
        printReview(page, review);
      } catch (err) {
        console.error(`  Error reviewing ${page.id}:`, err instanceof Error ? err.message : err);
      }
    }

    printBatchSummary(results);
  } else {
    const page = findPage(pages, pageId);
    if (!page) {
      console.error(`Page not found: ${pageId}`);
      process.exit(1);
    }

    const filePath = getFilePath(page.path);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const review = await adversarialReviewPhase(page, content, options);
    printReview(page, review);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
