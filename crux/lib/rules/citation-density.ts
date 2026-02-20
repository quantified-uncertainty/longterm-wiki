/**
 * Citation Density Validation Rule
 *
 * Enforces minimum citation requirements per entity type.
 * Pages about people, organizations, and historical events carry higher
 * hallucination risk and require more citations to support factual claims.
 *
 * Minimum footnote requirements by entity type:
 *   - person: 5 (biographical claims need verification)
 *   - organization: 3 (founding, funding, activities)
 *   - historical: 8 (dates, events, causes)
 *   - risk: 3 (risk assessments need evidence)
 *   - concept: 2 (definitions and key claims)
 *   - overview: 4 (broad claims across topics)
 *
 * Initially advisory (WARNING severity). Intended to become blocking
 * after Phase 1 citation backfill is complete (see issue #200).
 *
 * Only applies to knowledge-base pages with 300+ words of prose.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { shouldSkipValidation } from '../mdx-utils.ts';
import { countProseWords, getEntityTypeFromPath } from '../page-analysis.ts';
import { findFootnoteRefs } from '../content-integrity.ts';

/** Minimum word count before citation density applies */
const MIN_WORDS = 300;

/** Minimum citation counts by entity type / directory */
const CITATION_MINIMUMS: Record<string, number> = {
  person: 5,
  organization: 3,
  historical: 8,
  risk: 3,
  concept: 2,
  overview: 4,
  response: 3,
  model: 3,
  capability: 2,
  metric: 2,
  debate: 3,
  crux: 2,
};

/** Default minimum for entity types not listed above */
const DEFAULT_MINIMUM = 2;

/** Count all citation types: footnotes [^N] and <R id=...> components.
 *  Delegates footnote counting to findFootnoteRefs() (DRY, issue #417). */
function countCitations(body: string): number {
  const footnoteCount = findFootnoteRefs(body).size;
  const rMatches = body.match(/<R\s+id=/g);
  return footnoteCount + (rMatches ? rMatches.length : 0);
}

export const citationDensityRule = {
  id: 'citation-density',
  name: 'Citation Density',
  description: 'Enforce minimum citation counts per entity type to reduce hallucination risk',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Only apply to knowledge-base pages
    if (!contentFile.relativePath.startsWith('knowledge-base/')) {
      return issues;
    }

    // Skip index pages, stubs, documentation
    if (contentFile.isIndex || shouldSkipValidation(contentFile.frontmatter)) {
      return issues;
    }

    const body = contentFile.body || '';
    if (!body) return issues;

    const proseWords = countProseWords(body);
    if (proseWords < MIN_WORDS) return issues;

    const entityType = getEntityTypeFromPath(contentFile.relativePath);
    if (!entityType) return issues;

    const citationCount = countCitations(body);
    const minimum = CITATION_MINIMUMS[entityType] ?? DEFAULT_MINIMUM;

    if (citationCount < minimum) {
      const shortfall = minimum - citationCount;
      issues.push(new Issue({
        rule: 'citation-density',
        file: contentFile.path,
        line: 1,
        message: `${entityType} page has ${citationCount} citation(s), minimum is ${minimum} (needs ${shortfall} more). ` +
          `Run: pnpm crux content improve ${contentFile.slug.split('/').pop()} --tier=standard --apply`,
        severity: Severity.WARNING,
      }));
    }

    return issues;
  },
};
