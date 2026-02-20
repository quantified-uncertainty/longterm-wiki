#!/usr/bin/env node
/**
 * fix-legacy-frontmatter.mjs
 * Migrates legacy frontmatter fields:
 *   - importance: → readerImportance: (or removed if readerImportance already exists)
 *   - lastUpdated: → lastEdited: "YYYY-MM-DD" (frontmatter only)
 *   - todo: → todos: (array form)
 *   - entityId: → remove entirely
 *
 * Usage: node scripts/fix-legacy-frontmatter.mjs [--dry-run]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const contentDir = path.join(repoRoot, 'content/docs');

const dryRun = process.argv.includes('--dry-run');

// --- Helpers ---

/**
 * Split a file into {frontmatter, body, hasFrontmatter}.
 * Returns null if file has no frontmatter block.
 */
function splitFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return null;
  return {
    frontmatter: content.slice(4, end), // raw YAML text (no --- delimiters)
    body: content.slice(end + 5),       // everything after closing ---\n
  };
}

function joinFrontmatter(frontmatter, body) {
  return `---\n${frontmatter}\n---\n${body}`;
}

/**
 * Fix importance: → readerImportance: (or delete if readerImportance already present).
 */
function fixImportance(fm) {
  if (!/^importance:/m.test(fm)) return { fm, changed: false };
  const hasReaderImportance = /^readerImportance:/m.test(fm);
  if (hasReaderImportance) {
    // Remove the importance: line entirely
    return { fm: fm.replace(/^importance:.*\n?/m, ''), changed: true, action: 'removed importance: (readerImportance already present)' };
  } else {
    // Rename importance: → readerImportance:
    return { fm: fm.replace(/^importance:/m, 'readerImportance:'), changed: true, action: 'renamed importance: → readerImportance:' };
  }
}

/**
 * Fix lastUpdated: → lastEdited: "YYYY-MM-DD" (only simple date values; skip booleans/strings).
 */
function fixLastUpdated(fm) {
  if (!/^lastUpdated:/m.test(fm)) return { fm, changed: false };
  // Match YYYY-MM-DD date values (unquoted, as YAML dates)
  const dateMatch = fm.match(/^lastUpdated: (\d{4}-\d{2}-\d{2})\s*$/m);
  if (!dateMatch) {
    // Could be a boolean or other value — skip
    console.warn('  WARNING: lastUpdated value is not a simple date, skipping');
    return { fm, changed: false };
  }
  const dateStr = dateMatch[1];
  // Only replace if lastEdited doesn't already exist
  if (/^lastEdited:/m.test(fm)) {
    // Already has lastEdited — just remove the lastUpdated line
    return {
      fm: fm.replace(/^lastUpdated:.*\n?/m, ''),
      changed: true,
      action: `removed lastUpdated: (lastEdited already present)`,
    };
  }
  // Replace lastUpdated: YYYY-MM-DD → lastEdited: "YYYY-MM-DD"
  return {
    fm: fm.replace(/^lastUpdated: \d{4}-\d{2}-\d{2}\s*$/m, `lastEdited: "${dateStr}"`),
    changed: true,
    action: `renamed lastUpdated: ${dateStr} → lastEdited: "${dateStr}"`,
  };
}

/**
 * Fix todo: "value" → todos:\n  - value
 * Handles both quoted and unquoted values (single-line only).
 */
function fixTodo(fm) {
  if (!/^todo:/m.test(fm)) return { fm, changed: false };

  // Match: todo: "quoted value" or todo: unquoted value
  const quotedMatch = fm.match(/^todo: "(.+)"\s*$/m);
  const unquotedMatch = !quotedMatch && fm.match(/^todo: (.+)\s*$/m);

  let rawValue;
  if (quotedMatch) {
    rawValue = quotedMatch[1];
  } else if (unquotedMatch) {
    rawValue = unquotedMatch[1];
  } else {
    console.warn('  WARNING: Could not parse todo: value, skipping');
    return { fm, changed: false };
  }

  const replacement = `todos:\n  - ${rawValue}`;
  const original = quotedMatch ? `todo: "${rawValue}"` : `todo: ${rawValue}`;
  return {
    fm: fm.replace(/^todo: .+\s*$/m, replacement),
    changed: true,
    action: `converted todo: → todos: (array)`,
  };
}

/**
 * Fix entityId: → remove entirely.
 */
function fixEntityId(fm) {
  if (!/^entityId:/m.test(fm)) return { fm, changed: false };
  return {
    fm: fm.replace(/^entityId:.*\n?/m, ''),
    changed: true,
    action: 'removed entityId:',
  };
}

// --- Main ---

function processFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = splitFrontmatter(content);
  if (!parsed) return; // no frontmatter

  let { frontmatter, body } = parsed;
  const changes = [];

  for (const [fixName, fixFn] of [
    ['importance', fixImportance],
    ['lastUpdated', fixLastUpdated],
    ['todo', fixTodo],
    ['entityId', fixEntityId],
  ]) {
    const result = fixFn(frontmatter);
    if (result.changed) {
      frontmatter = result.fm;
      changes.push(result.action || fixName);
    }
  }

  if (changes.length === 0) return;

  const relPath = path.relative(repoRoot, filePath);
  console.log(`\n${dryRun ? '[DRY RUN] ' : ''}${relPath}`);
  for (const change of changes) {
    console.log(`  • ${change}`);
  }

  if (!dryRun) {
    fs.writeFileSync(filePath, joinFrontmatter(frontmatter, body), 'utf8');
  }
}

function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath);
    } else if (entry.name.endsWith('.mdx') || entry.name.endsWith('.md')) {
      processFile(fullPath);
    }
  }
}

console.log(`Scanning ${contentDir}${dryRun ? ' (dry run)' : ''}…\n`);
walkDir(contentDir);
console.log('\nDone.');
