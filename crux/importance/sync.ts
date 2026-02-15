#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Sync Importance Scores
 *
 * Derives 0-100 importance scores from the ranking and writes them
 * to page frontmatter. The ranking file is the source of truth;
 * this command propagates it to the individual MDX files.
 *
 * Usage:
 *   pnpm crux importance sync             # Preview changes (dry run)
 *   pnpm crux importance sync --apply     # Write changes to frontmatter
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseCliArgs } from '../lib/cli.ts';
import { createLogger } from '../lib/output.ts';
import { CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { loadRanking, deriveScores } from '../lib/importance-ranking.ts';

const args = parseCliArgs(process.argv.slice(2));
const log = createLogger(args.ci as boolean);
const c = log.colors;
const apply = args.apply === true;

async function main() {
  const { ranking } = loadRanking();

  if (ranking.length === 0) {
    log.warn('Ranking is empty. Run `pnpm crux importance seed` first.');
    process.exit(0);
  }

  const scores = deriveScores(ranking);
  const scoreMap = new Map<string, number>();
  for (const { id, score } of scores) {
    scoreMap.set(id, score);
  }

  // Find all MDX files and build ID → path mapping
  const files = findMdxFiles(CONTENT_DIR_ABS);
  const pageFiles = new Map<string, string>();
  for (const f of files) {
    const match = f.match(/([^/]+)\.mdx?$/);
    if (match && match[1] !== 'index') {
      pageFiles.set(match[1], f);
    }
  }

  let changed = 0;
  let unchanged = 0;
  let notInRanking = 0;
  const changes: Array<{ id: string; oldScore: number | null; newScore: number }> = [];

  for (const [pageId, filePath] of pageFiles) {
    const newScore = scoreMap.get(pageId);
    if (newScore === undefined) {
      notInRanking++;
      continue;
    }

    const content = readFileSync(filePath, 'utf-8');

    // Parse current importance from frontmatter
    const importanceMatch = content.match(/^importance:\s*([\d.]+)\s*$/m);
    const currentScore = importanceMatch ? parseFloat(importanceMatch[1]) : null;

    if (currentScore !== null && Math.abs(currentScore - newScore) < 0.25) {
      unchanged++;
      continue;
    }

    changes.push({ id: pageId, oldScore: currentScore, newScore });

    if (apply) {
      let updated: string;
      if (importanceMatch) {
        // Replace existing importance line
        updated = content.replace(
          /^importance:\s*[\d.]+\s*$/m,
          `importance: ${newScore}`,
        );
      } else {
        // Insert importance after quality line, or after title
        const qualityMatch = content.match(/^quality:\s*[\d.]+\s*$/m);
        if (qualityMatch) {
          updated = content.replace(
            /^(quality:\s*[\d.]+)\s*$/m,
            `$1\nimportance: ${newScore}`,
          );
        } else {
          // Insert after frontmatter opening
          updated = content.replace(
            /^(---\n(?:.*\n)*?title:\s*.+)$/m,
            `$1\nimportance: ${newScore}`,
          );
        }
      }

      writeFileSync(filePath, updated, 'utf-8');
    }

    changed++;
  }

  // Display results
  log.heading(`Importance Sync ${apply ? '(applied)' : '(dry run)'}`);
  console.log('');

  if (changes.length > 0) {
    // Sort by new score descending for display
    changes.sort((a, b) => b.newScore - a.newScore);

    for (const { id, oldScore, newScore } of changes.slice(0, 50)) {
      const old = oldScore !== null ? oldScore.toFixed(1) : 'none';
      const arrow = apply ? '→' : '→';
      console.log(
        `  ${c.dim}${id.padEnd(45)}${c.reset} ${old.padStart(5)} ${arrow} ${c.cyan}${newScore.toFixed(1).padStart(5)}${c.reset}`,
      );
    }
    if (changes.length > 50) {
      console.log(`  ${c.dim}... and ${changes.length - 50} more${c.reset}`);
    }
  }

  console.log('');
  log.dim(`Changed: ${changed} | Unchanged: ${unchanged} | Not in ranking: ${notInRanking}`);

  if (!apply && changed > 0) {
    console.log('');
    log.info('Run with --apply to write changes to frontmatter.');
  }
}

main().catch((err) => {
  log.error(`Error: ${err.message}`);
  process.exit(1);
});
