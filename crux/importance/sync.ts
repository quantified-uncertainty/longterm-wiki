#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Sync Importance Scores
 *
 * Derives 0-100 scores from both ranking files and writes them to page frontmatter.
 *   - readerImportance:    from data/importance-ranking.yaml (readership)
 *   - researchImportance:  from data/research-ranking.yaml  (research)
 *
 * Usage:
 *   pnpm crux importance sync             # Preview changes (dry run)
 *   pnpm crux importance sync --apply     # Write changes to frontmatter
 */

import { readFileSync, writeFileSync } from 'fs';
import { parseCliArgs } from '../lib/cli.ts';
import { createLogger } from '../lib/output.ts';
import { CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { loadRanking, deriveScores, getAvailableDimensions } from '../lib/importance-ranking.ts';

const args = parseCliArgs(process.argv.slice(2));
const log = createLogger(args.ci as boolean);
const c = log.colors;
const apply = args.apply === true;

/** Field name in frontmatter for each dimension. */
const FRONTMATTER_FIELDS: Record<string, string> = {
  readership: 'readerImportance',
  research: 'researchImportance',
};

interface ScoreChange {
  id: string;
  field: string;
  oldScore: number | null;
  newScore: number;
}

function syncDimension(
  dimension: string,
  pageFiles: Map<string, string>,
  pageContents: Map<string, string>,
): { changes: ScoreChange[]; unchanged: number; notInRanking: number } {
  const field = FRONTMATTER_FIELDS[dimension];
  if (!field) return { changes: [], unchanged: 0, notInRanking: 0 };

  const { ranking } = loadRanking(dimension);
  if (ranking.length === 0) {
    return { changes: [], unchanged: 0, notInRanking: pageFiles.size };
  }

  const scores = deriveScores(ranking);
  const scoreMap = new Map<string, number>();
  for (const { id, score } of scores) {
    scoreMap.set(id, score);
  }

  const changes: ScoreChange[] = [];
  let unchanged = 0;
  let notInRanking = 0;

  for (const [pageId, filePath] of pageFiles) {
    const newScore = scoreMap.get(pageId);
    if (newScore === undefined) {
      notInRanking++;
      continue;
    }

    const content = pageContents.get(pageId) || readFileSync(filePath, 'utf-8');
    const fieldRegex = new RegExp(`^${field}:\\s*([\\d.]+)\\s*$`, 'm');
    const match = content.match(fieldRegex);
    const currentScore = match ? parseFloat(match[1]) : null;

    if (currentScore !== null && Math.abs(currentScore - newScore) < 0.25) {
      unchanged++;
      continue;
    }

    changes.push({ id: pageId, field, oldScore: currentScore, newScore });

    if (apply) {
      let updated: string;
      if (match) {
        updated = content.replace(fieldRegex, `${field}: ${newScore}`);
      } else if (field === 'readerImportance') {
        // Insert readerImportance after quality line
        const qualityMatch = content.match(/^quality:\s*[\d.]+\s*$/m);
        if (qualityMatch) {
          updated = content.replace(
            /^(quality:\s*[\d.]+)\s*$/m,
            `$1\nreaderImportance: ${newScore}`,
          );
        } else {
          updated = content.replace(
            /^(---\n(?:.*\n)*?title:\s*.+)$/m,
            `$1\nreaderImportance: ${newScore}`,
          );
        }
      } else {
        // Insert researchImportance after importance line, or after quality
        const impMatch = content.match(/^readerImportance:\s*[\d.]+\s*$/m);
        if (impMatch) {
          updated = content.replace(
            /^(readerImportance:\s*[\d.]+)\s*$/m,
            `$1\n${field}: ${newScore}`,
          );
        } else {
          const qualityMatch = content.match(/^quality:\s*[\d.]+\s*$/m);
          if (qualityMatch) {
            updated = content.replace(
              /^(quality:\s*[\d.]+)\s*$/m,
              `$1\n${field}: ${newScore}`,
            );
          } else {
            updated = content.replace(
              /^(---\n(?:.*\n)*?title:\s*.+)$/m,
              `$1\n${field}: ${newScore}`,
            );
          }
        }
      }

      writeFileSync(filePath, updated, 'utf-8');
      pageContents.set(pageId, updated); // Update cache for next dimension
    }
  }

  return { changes, unchanged, notInRanking };
}

async function main() {
  // Find all MDX files
  const files = findMdxFiles(CONTENT_DIR_ABS);
  const pageFiles = new Map<string, string>();
  const pageContents = new Map<string, string>();
  for (const f of files) {
    const match = f.match(/([^/]+)\.mdx?$/);
    if (match && match[1] !== 'index') {
      pageFiles.set(match[1], f);
      pageContents.set(match[1], readFileSync(f, 'utf-8'));
    }
  }

  const availableDims = getAvailableDimensions();
  if (availableDims.length === 0) {
    log.warn('No rankings found. Run `pnpm crux importance seed` or `pnpm crux importance rerank` first.');
    process.exit(0);
  }

  log.heading(`Importance Sync ${apply ? '(applied)' : '(dry run)'}`);

  let totalChanged = 0;

  for (const dim of availableDims) {
    const field = FRONTMATTER_FIELDS[dim];
    if (!field) continue;

    const { changes, unchanged, notInRanking } = syncDimension(dim, pageFiles, pageContents);

    console.log('');
    log.subheading(`${dim} → ${field}:`);

    if (changes.length > 0) {
      changes.sort((a, b) => b.newScore - a.newScore);
      for (const { id, oldScore, newScore } of changes.slice(0, 30)) {
        const old = oldScore !== null ? oldScore.toFixed(1) : 'none';
        console.log(
          `  ${c.dim}${id.padEnd(45)}${c.reset} ${old.padStart(5)} → ${c.cyan}${newScore.toFixed(1).padStart(5)}${c.reset}`,
        );
      }
      if (changes.length > 30) {
        console.log(`  ${c.dim}... and ${changes.length - 30} more${c.reset}`);
      }
    } else {
      log.dim('  No changes');
    }

    log.dim(`  Changed: ${changes.length} | Unchanged: ${unchanged} | Not in ranking: ${notInRanking}`);
    totalChanged += changes.length;
  }

  if (!apply && totalChanged > 0) {
    console.log('');
    log.info('Run with --apply to write changes to frontmatter.');
  }
}

main().catch((err) => {
  log.error(`Error: ${err.message}`);
  process.exit(1);
});
