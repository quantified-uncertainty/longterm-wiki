#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Show Importance Rankings
 *
 * Displays the current ranking with derived scores, and optionally
 * lists unranked pages.
 *
 * Usage:
 *   pnpm crux importance show              # Show full ranking
 *   pnpm crux importance show --unranked   # Also show unranked pages
 *   pnpm crux importance show --top=20     # Show top 20 only
 */

import { parseCliArgs } from '../lib/cli.ts';
import { createLogger } from '../lib/output.ts';
import { loadPages } from '../lib/content-types.ts';
import {
  loadRanking,
  deriveScores,
  findUnrankedPages,
  findOrphanedEntries,
} from '../lib/importance-ranking.ts';

const args = parseCliArgs(process.argv.slice(2));
const log = createLogger(args.ci as boolean);
const c = log.colors;

async function main() {
  const { ranking } = loadRanking();
  const scores = deriveScores(ranking);

  // Build title lookup from pages.json
  const pages = loadPages();
  const titleMap = new Map<string, string>();
  for (const p of pages) {
    titleMap.set(p.id, p.title);
  }

  // Determine how many to show
  const top = args.top ? parseInt(args.top as string, 10) : ranking.length;

  log.heading(`Importance Ranking (${ranking.length} pages ranked)`);
  console.log('');

  // Show ranking table
  const displayed = scores.slice(0, top);
  const posWidth = String(ranking.length).length;

  for (const { id, position, score } of displayed) {
    const title = titleMap.get(id) || id;
    const pos = String(position).padStart(posWidth);
    const sc = score.toFixed(1).padStart(5);
    console.log(`  ${c.dim}${pos}.${c.reset} ${c.cyan}${sc}${c.reset}  ${title} ${c.dim}(${id})${c.reset}`);
  }

  if (top < ranking.length) {
    console.log(`  ${c.dim}... and ${ranking.length - top} more${c.reset}`);
  }

  // Show orphaned entries (IDs in ranking that don't have pages)
  const orphaned = findOrphanedEntries(ranking);
  if (orphaned.length > 0) {
    console.log('');
    log.warn(`${orphaned.length} orphaned entries (in ranking but no page exists):`);
    for (const id of orphaned) {
      console.log(`  ${c.yellow}${id}${c.reset}`);
    }
  }

  // Optionally show unranked pages
  if (args.unranked) {
    const unranked = findUnrankedPages(ranking);
    console.log('');
    log.subheading(`Unranked pages (${unranked.length}):`);
    for (const id of unranked.sort()) {
      const title = titleMap.get(id) || id;
      console.log(`  ${c.dim}-${c.reset} ${title} ${c.dim}(${id})${c.reset}`);
    }
  }

  // Summary
  console.log('');
  const unrankedCount = findUnrankedPages(ranking).length;
  log.dim(`Ranked: ${ranking.length} | Unranked: ${unrankedCount} | Total: ${ranking.length + unrankedCount}`);
}

main().catch((err) => {
  log.error(`Error: ${err.message}`);
  process.exit(1);
});
