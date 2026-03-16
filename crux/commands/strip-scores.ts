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

import { readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { parse as parseYaml } from 'yaml';
import { FRONTMATTER_RE } from '../lib/patterns.ts';
import { reorderFrontmatterObject } from '../lib/frontmatter-order.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { safeStringifyFm } from '../authoring/grading/apply.ts';

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
 * Parse a file, detect strippable fields, and optionally rewrite it.
 * Returns null if no fields to strip. When apply=true, writes the file.
 */
function processFile(
  filePath: string,
  fieldsToStrip: Set<StrippableField>,
  apply: boolean,
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

  const id = relative(CONTENT_DIR, filePath).replace(/\.(mdx|md)$/, '');

  if (apply) {
    const orderedFm = reorderFrontmatterObject(fm);
    let newFm = safeStringifyFm(orderedFm);
    if (!newFm.endsWith('\n')) newFm += '\n';

    const bodyStart = content.indexOf('---', 4) + 3;
    let body = content.slice(bodyStart);
    body = '\n' + body.replace(/^\n+/, '');
    const newContent = `---\n${newFm}---${body}`;

    const fmTest = newContent.match(/^---\n[\s\S]*?\n---\n/);
    if (!fmTest) {
      console.error(`ERROR: Invalid frontmatter structure after strip in ${filePath}`);
      return null;
    }

    writeFileSync(filePath, newContent);
  }

  return { filePath, pageId: id, fieldsRemoved: removed };
}

export async function run(args: string[]) {
  const fieldsArg = args.find(a => a.startsWith('--fields='))?.split('=')[1];
  const apply = args.includes('--apply');

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
  console.log(`Mode: ${apply ? 'APPLY (will modify files)' : 'dry-run (preview only)'}\n`);

  const mdxFiles = findMdxFiles(CONTENT_DIR);
  console.log(`Found ${mdxFiles.length} MDX files\n`);

  const results: StripResult[] = [];
  let errors = 0;

  for (const filePath of mdxFiles) {
    const result = processFile(filePath, fieldsToStrip, apply);
    if (result) results.push(result);
    else if (apply) {
      // processFile returns null both for "no fields to strip" and "write error"
      // We only count errors for files we know had fields to strip
    }
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

  const verb = apply ? 'Stripped from' : 'Would strip from';
  console.log(`${verb} ${results.length} files:`);
  for (const [field, count] of Object.entries(byCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${field}: ${count} files`);
  }

  if (!apply) {
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

  console.log(`\nDone: ${results.length} files updated.`);
}

// Standalone entrypoint
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((err) => {
    console.error('strip-scores failed:', err);
    process.exit(1);
  });
}
