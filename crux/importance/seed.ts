#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Seed Importance Ranking
 *
 * Bootstraps the ranking from existing importance scores in page frontmatter.
 * Pages are sorted by their current importance score (highest first), giving
 * an initial ordering to refine through comparisons.
 *
 * This is a one-time setup command. If a ranking already exists, it will
 * only add pages that aren't yet ranked (preserving existing order).
 *
 * Usage:
 *   pnpm crux importance seed             # Preview what would be seeded
 *   pnpm crux importance seed --apply     # Write the seeded ranking
 */

import { readFileSync } from 'fs';
import { parseCliArgs } from '../lib/cli.ts';
import { createLogger } from '../lib/output.ts';
import { CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import {
  loadRanking,
  saveRanking,
  getAllPageIds,
} from '../lib/importance-ranking.ts';

const args = parseCliArgs(process.argv.slice(2));
const log = createLogger(args.ci as boolean);
const c = log.colors;
const apply = args.apply === true;

interface PageScore {
  id: string;
  title: string;
  importance: number;
}

async function main() {
  const existing = loadRanking();
  const existingSet = new Set(existing.ranking);

  // Read importance scores from all MDX files
  const files = findMdxFiles(CONTENT_DIR_ABS);
  const pageScores: PageScore[] = [];

  for (const filePath of files) {
    const match = filePath.match(/([^/]+)\.mdx?$/);
    if (!match || match[1] === 'index') continue;

    const id = match[1];
    if (existingSet.has(id)) continue; // Already ranked

    const content = readFileSync(filePath, 'utf-8');

    // Extract title
    const titleMatch = content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
    const title = titleMatch ? titleMatch[1] : id;

    // Extract importance (prefer readerImportance, fall back to legacy importance:)
    const readerImportanceMatch = content.match(/^readerImportance:\s*([\d.]+)\s*$/m);
    const legacyImportanceMatch = !readerImportanceMatch && content.match(/^importance:\s*([\d.]+)\s*$/m);
    const importance = readerImportanceMatch ? parseFloat(readerImportanceMatch[1]) :
                       legacyImportanceMatch ? parseFloat(legacyImportanceMatch[1]) : 0;

    pageScores.push({ id, title, importance });
  }

  // Sort by importance descending, then alphabetically for ties
  pageScores.sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return a.title.localeCompare(b.title);
  });

  // Separate scored from unscored
  const scored = pageScores.filter((p) => p.importance > 0);
  const unscored = pageScores.filter((p) => p.importance === 0);

  log.heading(`Seed Importance Ranking ${apply ? '(applying)' : '(dry run)'}`);
  console.log('');

  if (existing.ranking.length > 0) {
    log.dim(`Existing ranking: ${existing.ranking.length} pages (preserved)`);
  }

  log.subheading(`Pages with importance scores (${scored.length}):`);
  for (const { id, title, importance } of scored.slice(0, 30)) {
    console.log(
      `  ${c.cyan}${importance.toFixed(1).padStart(5)}${c.reset}  ${title} ${c.dim}(${id})${c.reset}`,
    );
  }
  if (scored.length > 30) {
    console.log(`  ${c.dim}... and ${scored.length - 30} more${c.reset}`);
  }

  console.log('');
  log.dim(`Unscored pages (importance=0): ${unscored.length} — these will be appended at the end`);

  // Build final ranking: existing + scored + unscored
  const newRanking = [...existing.ranking, ...scored.map((p) => p.id), ...unscored.map((p) => p.id)];

  if (apply) {
    saveRanking({ ranking: newRanking });
    console.log('');
    log.success(`Ranking saved with ${newRanking.length} pages`);
    log.dim(`  ${existing.ranking.length} preserved + ${scored.length} scored + ${unscored.length} unscored`);
    console.log('');
    log.info('Next steps:');
    log.info('  pnpm crux importance show --top=30    # Review the ranking');
    log.info('  pnpm crux importance rank --batch=20  # Refine with LLM comparisons');
    log.info('  pnpm crux importance sync --apply     # Write scores to frontmatter');
  } else {
    console.log('');
    log.dim(`Would create ranking with ${newRanking.length} pages`);
    log.info('Run with --apply to save.');
  }
}

main().catch((err) => {
  log.error(`Error: ${err.message}`);
  process.exit(1);
});
