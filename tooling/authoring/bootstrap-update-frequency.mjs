#!/usr/bin/env node

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
 *   node tooling/authoring/bootstrap-update-frequency.mjs              # Dry run
 *   node tooling/authoring/bootstrap-update-frequency.mjs --apply      # Apply changes
 *   node tooling/authoring/bootstrap-update-frequency.mjs --verbose    # Show all pages
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

const PROJECT_ROOT = process.cwd();
const CONTENT_DIR = join(PROJECT_ROOT, 'content/docs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FREQUENCY_RULES = [
  { minImportance: 80, frequency: 7 },
  { minImportance: 60, frequency: 21 },
  { minImportance: 40, frequency: 45 },
  { minImportance: 20, frequency: 90 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findMdxFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMdxFiles(fullPath));
    } else if (/\.(mdx?|md)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

// parseFrontmatter is defined inside main() after yaml is imported

/**
 * Insert update_frequency into frontmatter YAML string without rewriting the whole thing.
 * Places it after lastEdited or importance, whichever comes last.
 */
function insertUpdateFrequency(content, frequency) {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) return content;

  const yaml = fmMatch[2];
  const lines = yaml.split('\n');

  // Find best insertion point: after lastEdited, importance, or at end of top-level fields
  let insertAfter = -1;
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

function getFrequencyForImportance(importance) {
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

async function main() {
  const { parse: parseYaml } = await import('yaml');
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const verbose = args.includes('--verbose');

  // Override parseFrontmatter with proper yaml import
  function parseFm(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    try {
      return parseYaml(match[1]) || {};
    } catch {
      return {};
    }
  }

  const files = findMdxFiles(CONTENT_DIR);

  let updated = 0;
  let skipped = 0;
  let alreadySet = 0;
  let noImportance = 0;
  let belowThreshold = 0;
  const changes = [];

  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf-8');
    const fm = parseFm(content);
    const rel = relative(CONTENT_DIR, filePath);

    // Skip index pages
    if (filePath.endsWith('index.mdx') || filePath.endsWith('index.md')) {
      skipped++;
      continue;
    }

    // Skip stubs
    if (fm.pageType === 'stub' || fm.pageType === 'documentation') {
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

    const importance = Number(fm.importance);
    const frequency = getFrequencyForImportance(importance);

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
      title: fm.title || rel,
      importance,
      frequency,
    });

    if (apply) {
      const newContent = insertUpdateFrequency(content, frequency);
      writeFileSync(filePath, newContent, 'utf-8');
    }

    updated++;
  }

  // Output summary
  console.log('\nBootstrap Update Frequency');
  console.log('─'.repeat(50));
  console.log(`  Total files scanned:    ${files.length}`);
  console.log(`  Already have frequency: ${alreadySet}`);
  console.log(`  No importance score:    ${noImportance}`);
  console.log(`  Below threshold (<20):  ${belowThreshold}`);
  console.log(`  Skipped (stubs/index):  ${skipped}`);
  console.log(`  ${apply ? 'Updated' : 'Would update'}:        ${updated}`);
  console.log('');

  // Show frequency distribution of changes
  const freqCounts = {};
  for (const ch of changes) {
    const label = `${ch.frequency}d`;
    freqCounts[label] = (freqCounts[label] || 0) + 1;
  }
  console.log('Frequency distribution of changes:');
  for (const [freq, count] of Object.entries(freqCounts).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
    console.log(`  ${freq.padEnd(5)} ${count} pages`);
  }
  console.log('');

  // Show individual changes (first 30 or all if verbose)
  const toShow = verbose ? changes : changes.slice(0, 30);
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

main().catch(console.error);
