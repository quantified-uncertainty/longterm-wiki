/**
 * Frontmatter application — writes grading results back to MDX source files.
 *
 * Handles YAML serialization, structural validation, and safe file writes.
 */

import { readFileSync, writeFileSync } from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { FRONTMATTER_RE } from '../../lib/patterns.ts';
import { reorderFrontmatterObject } from '../../lib/frontmatter-order.ts';
import { ensureMdxSafeYaml } from '../../lib/yaml-mdx-safe.ts';
import type { PageInfo, GradeResult, Metrics } from './types.ts';

/**
 * Safely serialize a frontmatter object to YAML.
 *
 * Tries PLAIN string type first (clean output), then falls back to
 * QUOTE_DOUBLE if round-trip validation fails (e.g. llmSummary with colons).
 */
function safeStringifyFm(obj: Record<string, unknown>): string {
  const plainYaml = stringifyYaml(obj, {
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
    lineWidth: 0,
  });

  // Round-trip validate: parse back to check for corruption
  try {
    const roundTripped = parseYaml(plainYaml);
    // Verify key fields survived the round-trip
    if (typeof obj.quality === 'number' && roundTripped?.quality !== obj.quality) {
      throw new Error('quality field lost in round-trip');
    }
    // Ensure \$ in plain YAML values are double-quoted for MDX safety.
    // Without this, remark-mdx-frontmatter converts \$ to invalid JS escapes.
    return ensureMdxSafeYaml(plainYaml);
  } catch {
    // PLAIN serialization produced invalid YAML — fall back to quoted strings
    return stringifyYaml(obj, {
      defaultStringType: 'QUOTE_DOUBLE',
      defaultKeyType: 'PLAIN',
      lineWidth: 0,
    });
  }
}

/** Apply grades to frontmatter YAML in the source file. */
export function applyGradesToFile(
  page: PageInfo,
  grades: GradeResult,
  metrics: Metrics,
  derivedQuality: number,
): boolean {
  const content = readFileSync(page.filePath, 'utf-8');
  const fmMatch = content.match(FRONTMATTER_RE);

  if (!fmMatch) {
    console.warn(`No frontmatter found in ${page.filePath}`);
    return false;
  }

  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(fmMatch[1]) || {} as Record<string, unknown>;
  } catch (err) {
    console.error(`ERROR: Failed to parse frontmatter in ${page.filePath}: ${err instanceof Error ? err.message : err}`);
    return false;
  }

  fm.readerImportance = grades.readerImportance;
  if (grades.tacticalValue != null) {
    fm.tacticalValue = grades.tacticalValue;
  }
  fm.quality = derivedQuality;
  if (grades.llmSummary) {
    fm.llmSummary = grades.llmSummary;
  }
  if (grades.ratings) {
    fm.ratings = grades.ratings;
  }
  // Metrics are computed at build time — not stored in frontmatter.
  delete fm.metrics;

  if (fm.lastEdited instanceof Date) {
    // lastEdited is deprecated; convert Date objects to strings for backward compat
    fm.lastEdited = fm.lastEdited.toISOString().split('T')[0];
  }

  // Reorder keys to canonical order before serialization so newly-added
  // fields (e.g. tacticalValue) land in the correct position.
  const orderedFm = reorderFrontmatterObject(fm);

  let newFm: string = safeStringifyFm(orderedFm);

  if (!newFm.endsWith('\n')) {
    newFm += '\n';
  }

  const bodyStart: number = content.indexOf('---', 4) + 3;
  let body: string = content.slice(bodyStart);
  body = '\n' + body.replace(/^\n+/, '');
  const newContent: string = `---\n${newFm}---${body}`;

  // Validation: ensure file structure is correct
  const fmTest = newContent.match(/^---\n[\s\S]*?\n---\n/);
  if (!fmTest) {
    console.error(`ERROR: Invalid frontmatter structure in ${page.filePath}`);
    console.error('Frontmatter must end with ---\\n');
    return false;
  }

  // Validation: ensure no corrupted imports
  const afterFm: string = newContent.slice(fmTest[0].length);
  if (/^[a-z]/.test(afterFm.trim()) && !/^(import|export|const|let|var|function|class|\/\/)/.test(afterFm.trim())) {
    console.error(`ERROR: Suspicious content after frontmatter in ${page.filePath}`);
    console.error(`First chars: "${afterFm.slice(0, 50)}..."`);
    return false;
  }

  writeFileSync(page.filePath, newContent);
  return true;
}
