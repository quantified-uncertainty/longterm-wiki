/**
 * Footnote Coverage Validation Rule
 *
 * Detects knowledge-base pages that lack footnote citations entirely.
 * Pages with substantial prose (300+ words) are expected to have at least
 * some footnote citations ([^1], [^2], etc.) to support factual claims.
 *
 * This catches cases where the page authoring pipeline produces content
 * without formal citations — e.g. when using the polish tier (no research
 * phase) or when pages are written manually without running the improve
 * pipeline.
 *
 * Only applies to pages under knowledge-base/. Skips index pages, stubs,
 * documentation pages, and short pages.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { shouldSkipValidation } from '../mdx-utils.ts';
import { countProseWords } from '../page-analysis.ts';
import { findFootnoteRefs } from '../content-integrity.ts';

/** Minimum word count to expect citations */
const MIN_WORDS_FOR_CITATIONS = 300;

/** Check if a page is under the knowledge-base directory */
function isKnowledgeBasePage(relativePath: string): boolean {
  return relativePath.startsWith('knowledge-base/');
}

export const footnoteCoverageRule = {
  id: 'footnote-coverage',
  name: 'Footnote Coverage',
  description: 'Detect knowledge-base pages that lack footnote citations',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Only apply to knowledge-base pages
    if (!isKnowledgeBasePage(contentFile.relativePath)) {
      return issues;
    }

    // Skip index pages, stubs, documentation, internal pages
    if (contentFile.isIndex || shouldSkipValidation(contentFile.frontmatter)) {
      return issues;
    }

    const body = contentFile.body || '';
    if (!body) return issues;

    const proseWords = countProseWords(body);

    // Skip short pages — not enough content to require citations
    if (proseWords < MIN_WORDS_FOR_CITATIONS) {
      return issues;
    }

    const footnoteCount = findFootnoteRefs(body).size;

    if (footnoteCount === 0) {
      issues.push(new Issue({
        rule: 'footnote-coverage',
        file: contentFile.path,
        line: 1,
        message: `No footnote citations found (${proseWords} words of prose). Knowledge-base pages should use [^N] footnotes with a Sources section to support factual claims.`,
        severity: Severity.WARNING,
      }));
    }

    return issues;
  },
};
