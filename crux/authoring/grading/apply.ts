/**
 * Frontmatter application — writes grading results back to MDX source files.
 *
 * Handles YAML serialization, structural validation, and safe file writes.
 */

import { readFileSync, writeFileSync } from 'fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { FRONTMATTER_RE } from '../../lib/patterns.ts';
import type { PageInfo, GradeResult } from './types.ts';

/** Apply grades to frontmatter YAML in the source file. */
export function applyGradesToFile(
  page: PageInfo,
  grades: GradeResult,
  metrics: { wordCount: number; citations: number; tables: number; diagrams: number },
  derivedQuality: number,
): boolean {
  const content = readFileSync(page.filePath, 'utf-8');
  const fmMatch = content.match(FRONTMATTER_RE);

  if (!fmMatch) {
    console.warn(`No frontmatter found in ${page.filePath}`);
    return false;
  }

  const fm = parseYaml(fmMatch[1]) || {} as Record<string, unknown>;

  fm.readerImportance = grades.readerImportance;
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
    fm.lastEdited = fm.lastEdited.toISOString().split('T')[0];
  }

  let newFm: string = stringifyYaml(fm, {
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
    lineWidth: 0,
  });

  // Ensure lastEdited is always quoted
  newFm = newFm.replace(/^(lastEdited:\s*)(\d{4}-\d{2}-\d{2})$/m, '$1"$2"');

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
