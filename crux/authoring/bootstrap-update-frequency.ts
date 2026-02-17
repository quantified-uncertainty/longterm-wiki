#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Bootstrap Update Frequency
 *
 * Sets initial `update_frequency` (days) on pages based on their importance score.
 * Only affects pages that have an importance score but no update_frequency yet.
 *
 * Rules:
 *   importance >= 80  → update_frequency: 7    (weekly)
 *   importance >= 60  → update_frequency: 21   (3 weeks)
 *   importance >= 40  → update_frequency: 45   (6 weeks)
 *   importance >= 20  → update_frequency: 90   (3 months)
 *   importance < 20   → not set (too low priority for scheduled updates)
 *
 * Usage:
 *   node crux/authoring/bootstrap-update-frequency.ts              # Dry run
 *   node crux/authoring/bootstrap-update-frequency.ts --apply      # Apply changes
 *   node crux/authoring/bootstrap-update-frequency.ts --verbose    # Show all pages
 */

import { readFileSync, writeFileSync } from 'fs';
import { relative } from 'path';
import { fileURLToPath } from 'url';
import { CONTENT_DIR_ABS as CONTENT_DIR } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface FrequencyRule {
  minImportance: number;
  frequency: number;
}

const FREQUENCY_RULES: FrequencyRule[] = [
  { minImportance: 80, frequency: 7 },
  { minImportance: 60, frequency: 21 },
  { minImportance: 40, frequency: 45 },
  { minImportance: 20, frequency: 90 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert update_frequency into frontmatter YAML string without rewriting the whole thing.
 * Places it after lastEdited or importance, whichever comes last.
 */
function insertUpdateFrequency(content: string, frequency: number): string {
  const fmMatch: RegExpMatchArray | null = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) return content;

  const yaml: string = fmMatch[2];
  const lines: string[] = yaml.split('\n');

  // Find best insertion point: after lastEdited, importance, or at end of top-level fields
  let insertAfter: number = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^(lastEdited|importance):/.test(lines[i])) {
      insertAfter = i;
    }
  }
  if (insertAfter === -1) {
    // Just insert before the last line
    insertAfter = lines.length - 1;
  }

  lines.splice(insertAfter + 1, 0, `update_frequency: ${frequency}`);

  return `${fmMatch[1]}${lines.join('\n')}${fmMatch[3]}${content.slice(fmMatch[0].length)}`;
}

function getFrequencyForImportance(importance: number): number | null {
  for (const rule of FREQUENCY_RULES) {
    if (importance >= rule.minImportance) {
      return rule.frequency;
    }
  }
  return null; // Below threshold
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Change {
  filePath: string;
  rel: string;
  title: string;
  importance: number;
  frequency: number;
}

async function main(): Promise<void> {
  const args: string[] = process.argv.slice(2);
  const apply: boolean = args.includes('--apply');
  const verbose: boolean = args.includes('--verbose');

  // Override parseFrontmatter with proper yaml import
  function parseFm(content: string): Record<string, unknown> {
    const match: RegExpMatchArray | null = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    try {
      return (parseYaml(match[1]) as Record<string, unknown>) || {};
    } catch {
      return {};
    }
  }

  const files: string[] = findMdxFiles(CONTENT_DIR);

  let updated: number = 0;
  let skipped: number = 0;
  let alreadySet: number = 0;
  let noImportance: number = 0;
  let belowThreshold: number = 0;
  const changes: Change[] = [];

  for (const filePath of files) {
    const content: string = readFileSync(filePath, 'utf-8');
    const fm: Record<string, unknown> = parseFm(content);
    const rel: string = relative(CONTENT_DIR, filePath);

    // Skip index pages
    if (filePath.endsWith('index.mdx') || filePath.endsWith('index.md')) {
      skipped++;
      continue;
    }

    // Skip stubs
    if (fm.pageType === 'stub' || fm.pageType === 'documentation' || fm.entityType === 'internal') {
      skipped++;
      continue;
    }

    // Skip non-evergreen pages (reports, blog posts)
    if (fm.evergreen === false) {
      skipped++;
      continue;
    }

    // Already has update_frequency
    if (fm.update_frequency != null) {
      alreadySet++;
      continue;
    }

    // No importance score
    if (fm.importance == null) {
      noImportance++;
      continue;
    }

    const importance: number = Number(fm.importance);
    const frequency: number | null = getFrequencyForImportance(importance);

    if (frequency === null) {
      belowThreshold++;
      if (verbose) {
        console.log(`  SKIP  imp=${importance}  ${rel}`);
      }
      continue;
    }

    changes.push({
      filePath,
      rel,
      title: (fm.title as string) || rel,
      importance,
      frequency,
    });

    if (apply) {
      const newContent: string = insertUpdateFrequency(content, frequency);
      writeFileSync(filePath, newContent, 'utf-8');
    }

    updated++;
  }

  // Output summary
  console.log('\nBootstrap Update Frequency');
  console.log('\u2500'.repeat(50));
  console.log(`  Total files scanned:    ${files.length}`);
  console.log(`  Already have frequency: ${alreadySet}`);
  console.log(`  No importance score:    ${noImportance}`);
  console.log(`  Below threshold (<20):  ${belowThreshold}`);
  console.log(`  Skipped (stubs/index):  ${skipped}`);
  console.log(`  ${apply ? 'Updated' : 'Would update'}:        ${updated}`);
  console.log('');

  // Show frequency distribution of changes
  const freqCounts: Record<string, number> = {};
  for (const ch of changes) {
    const label: string = `${ch.frequency}d`;
    freqCounts[label] = (freqCounts[label] || 0) + 1;
  }
  console.log('Frequency distribution of changes:');
  for (const [freq, count] of Object.entries(freqCounts).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
    console.log(`  ${freq.padEnd(5)} ${count} pages`);
  }
  console.log('');

  // Show individual changes (first 30 or all if verbose)
  const toShow: Change[] = verbose ? changes : changes.slice(0, 30);
  if (toShow.length > 0) {
    console.log(`${apply ? 'Updated' : 'Would update'} pages:`);
    for (const ch of toShow) {
      console.log(`  ${String(ch.frequency + 'd').padEnd(5)} imp=${String(ch.importance).padEnd(3)} ${ch.title}`);
    }
    if (!verbose && changes.length > 30) {
      console.log(`  ... and ${changes.length - 30} more (use --verbose to see all)`);
    }
  }

  if (!apply && updated > 0) {
    console.log(`\nDry run. Use --apply to write changes.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}
