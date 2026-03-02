/**
 * Block Section Quality Validation Rule (global scope)
 *
 * Uses the block-level IR (block-index.json) to detect structural issues
 * that are invisible to line-level text rules:
 *
 * 1. Uncited long sections: Sections with ≥200 words of prose and zero
 *    footnote citations. These are the highest-risk content for hallucination.
 *
 * 2. Empty sections: H2 sections with fewer than 10 words — likely leftover
 *    headings from templates or incomplete drafts.
 *
 * Only applies to knowledge-base pages. Skips preamble sections (level 0),
 * pages that failed block-IR parsing, and non-KB pages.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation/validation-engine.ts';
import { loadBlockIndex } from '../content-types.ts';
import type { BlockIndex } from '../content/block-ir.ts';

/** Minimum word count to flag an uncited section */
const UNCITED_MIN_WORDS = 200;

/** Sections below this word count are flagged as empty */
const EMPTY_SECTION_MAX_WORDS = 10;

/** Cache the block index across invocations within a single validation run */
let cachedIndex: BlockIndex | null = null;

function getBlockIndex(): BlockIndex {
  if (!cachedIndex) {
    cachedIndex = loadBlockIndex();
  }
  return cachedIndex;
}

/** Reset the cached index (used by tests) */
export function _resetCache(): void {
  cachedIndex = null;
}

export const blockSectionQualityRule = {
  id: 'block-section-quality',
  name: 'Block Section Quality',
  description: 'Detect uncited long sections and empty sections using block-level IR',
  scope: 'global' as const,

  check(files: ContentFile | ContentFile[], _engine: ValidationEngine): Issue[] {
    const contentFiles = Array.isArray(files) ? files : [files];
    const issues: Issue[] = [];

    const index = getBlockIndex();
    if (Object.keys(index).length === 0) return issues;

    for (const cf of contentFiles) {
      // Only apply to knowledge-base pages
      if (!cf.relativePath.startsWith('knowledge-base/')) continue;

      // Skip index pages and stubs
      if (cf.isIndex) continue;
      if (cf.frontmatter.pageType === 'stub') continue;

      // Resolve page ID from the content file's slug
      const pageId = cf.slug.replace(/^knowledge-base\//, '');
      const ir = index[pageId];
      if (!ir) continue;

      for (const section of ir.sections) {
        // Skip preamble
        if (section.level === 0) continue;

        // Check 1: Uncited long sections
        if (
          section.wordCount >= UNCITED_MIN_WORDS &&
          section.footnoteRefs.length === 0
        ) {
          issues.push(new Issue({
            rule: 'block-section-quality',
            file: cf.path,
            line: section.startLine,
            message: `Section "${section.heading}" has ${section.wordCount} words but no footnote citations — consider adding sources`,
            severity: Severity.WARNING,
          }));
        }

        // Check 2: Empty sections
        if (section.wordCount <= EMPTY_SECTION_MAX_WORDS) {
          issues.push(new Issue({
            rule: 'block-section-quality',
            file: cf.path,
            line: section.startLine,
            message: `Section "${section.heading}" has only ${section.wordCount} word${section.wordCount !== 1 ? 's' : ''} — remove or populate this section`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
};
