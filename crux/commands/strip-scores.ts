/**
 * Strip scoring fields from MDX frontmatter.
 *
 * Migration tool for the scoring redesign (epic #2428). Removes scoring
 * fields that have been migrated to PG assessments.
 *
 * Usage:
 *   pnpm crux content strip-scores --fields=quality,ratings --dry-run
 *   pnpm crux content strip-scores --fields=quality,ratings --apply
 *   pnpm crux content strip-scores --fields=readerImportance,researchImportance,tacticalValue --apply
 *   pnpm crux content strip-scores --fields=tractability,neglectedness --apply
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { FRONTMATTER_RE } from '../lib/patterns.ts';
import { reorderFrontmatterObject } from '../lib/frontmatter-order.ts';
import { ensureMdxSafeYaml } from '../lib/yaml-mdx-safe.ts';

const PROJECT_ROOT = join(import.meta.dirname!, '../..');
const CONTENT_DIR = join(PROJECT_ROOT, 'content/docs');

/** All fields that can be stripped. */
const VALID_FIELDS = [
  'quality',
  'readerImportance',
  'researchImportance',
  'tacticalValue',
  'tractability',
  'neglectedness',
  'uncertainty',
  'ratings',
] as const;

type StrippableField = typeof VALID_FIELDS[number];

interface StripResult {
  filePath: string;
  pageId: string;
  fieldsRemoved: string[];
}

/**
 * Safely serialize a frontmatter object to YAML (same logic as grading/apply.ts).
 */
function safeStringifyFm(obj: Record<string, unknown>): string {
  const plainYaml = stringifyYaml(obj, {
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
    lineWidth: 0,
  });

  try {
    const roundTripped = parseYaml(plainYaml);
    if (typeof obj.title === 'string' && roundTripped?.title !== obj.title) {
      throw new Error('title field lost in round-trip');
    }
    return ensureMdxSafeYaml(plainYaml);
  } catch {
    return stringifyYaml(obj, {
      defaultStringType: 'QUOTE_DOUBLE',
      defaultKeyType: 'PLAIN',
      lineWidth: 0,
    });
  }
}

/** Find all MDX files under content/docs recursively. */
function findMdxFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const fullPath = join(d, entry);
      if (statSync(fullPath).isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith('.mdx') || entry.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

/** Strip specified fields from a single file. Returns null if no changes. */
function stripFieldsFromFile(
  filePath: string,
  fieldsToStrip: Set<StrippableField>,
): StripResult | null {
  const content = readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(FRONTMATTER_RE);
  if (!fmMatch) return null;

  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(fmMatch[1]) || {};
  } catch {
    return null;
  }

  const removed: string[] = [];

  for (const field of fieldsToStrip) {
    if (field in fm) {
      delete fm[field];
      removed.push(field);
    }
  }

  if (removed.length === 0) return null;

  const id = relative(CONTENT_DIR, filePath).replace(/\.(mdx|md)$/, '').replace(/^.*\//, '');

  return {
    filePath,
    pageId: id,
    fieldsRemoved: removed,
  };
}

/** Apply the strip: rewrite the file with the field removed. */
function applyStrip(filePath: string, fieldsToStrip: Set<StrippableField>): boolean {
  const content = readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(FRONTMATTER_RE);
  if (!fmMatch) return false;

  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(fmMatch[1]) || {};
  } catch {
    return false;
  }

  let changed = false;
  for (const field of fieldsToStrip) {
    if (field in fm) {
      delete fm[field];
      changed = true;
    }
  }

  if (!changed) return false;

  const orderedFm = reorderFrontmatterObject(fm);
  let newFm = safeStringifyFm(orderedFm);
  if (!newFm.endsWith('\n')) newFm += '\n';

  const bodyStart = content.indexOf('---', 4) + 3;
  let body = content.slice(bodyStart);
  body = '\n' + body.replace(/^\n+/, '');
  const newContent = `---\n${newFm}---${body}`;

  // Validate structure
  const fmTest = newContent.match(/^---\n[\s\S]*?\n---\n/);
  if (!fmTest) {
    console.error(`ERROR: Invalid frontmatter structure after strip in ${filePath}`);
    return false;
  }

  writeFileSync(filePath, newContent);
  return true;
}

export async function run(args: string[]) {
  const fieldsArg = args.find(a => a.startsWith('--fields='))?.split('=')[1];
  const dryRun = !args.includes('--apply');

  if (!fieldsArg) {
    console.error('Usage: pnpm crux content strip-scores --fields=quality,ratings [--apply|--dry-run]');
    console.error(`\nValid fields: ${VALID_FIELDS.join(', ')}`);
    process.exit(1);
  }

  const requestedFields = fieldsArg.split(',') as StrippableField[];
  const invalidFields = requestedFields.filter(f => !VALID_FIELDS.includes(f));
  if (invalidFields.length > 0) {
    console.error(`Invalid fields: ${invalidFields.join(', ')}`);
    console.error(`Valid fields: ${VALID_FIELDS.join(', ')}`);
    process.exit(1);
  }

  const fieldsToStrip = new Set(requestedFields);
  console.log(`Fields to strip: ${[...fieldsToStrip].join(', ')}`);
  console.log(`Mode: ${dryRun ? 'dry-run (preview only)' : 'APPLY (will modify files)'}\n`);

  const mdxFiles = findMdxFiles(CONTENT_DIR);
  console.log(`Found ${mdxFiles.length} MDX files\n`);

  const results: StripResult[] = [];

  for (const filePath of mdxFiles) {
    const result = stripFieldsFromFile(filePath, fieldsToStrip);
    if (result) results.push(result);
  }

  if (results.length === 0) {
    console.log('No files have the specified fields — nothing to strip.');
    return;
  }

  // Summary by field
  const byCounts: Record<string, number> = {};
  for (const r of results) {
    for (const f of r.fieldsRemoved) {
      byCounts[f] = (byCounts[f] || 0) + 1;
    }
  }

  console.log(`Would strip from ${results.length} files:`);
  for (const [field, count] of Object.entries(byCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${field}: ${count} files`);
  }

  if (dryRun) {
    console.log('\n[dry-run] Sample files:');
    for (const r of results.slice(0, 15)) {
      console.log(`  ${r.pageId}: ${r.fieldsRemoved.join(', ')}`);
    }
    if (results.length > 15) {
      console.log(`  ... and ${results.length - 15} more`);
    }
    console.log('\nRun with --apply to actually strip fields.');
    return;
  }

  // Apply
  let applied = 0;
  let errors = 0;

  for (const r of results) {
    const ok = applyStrip(r.filePath, fieldsToStrip);
    if (ok) {
      applied++;
    } else {
      errors++;
      console.error(`  FAILED: ${r.pageId}`);
    }
  }

  console.log(`\nDone: ${applied} files updated, ${errors} errors.`);
  if (errors > 0) {
    process.exit(1);
  }
}

// Standalone entrypoint
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((err) => {
    console.error('strip-scores failed:', err);
    process.exit(1);
  });
}
