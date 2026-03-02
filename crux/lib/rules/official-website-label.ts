/**
 * Rule: Official Website Label on Abstract Entities
 *
 * Flags pages that use "Official Website" as a Quick Assessment link label
 * for entity types that cannot have an official website (abstract concepts,
 * debates, analysis types, etc.).
 *
 * Only organizations, persons, projects, funders, and similar real-world
 * entities can have a meaningful "Official Website". Abstract types like
 * concept, debate, crux, risk, analysis, parameter, etc. should use
 * "Related Resource", "See Also", or similar labels instead.
 *
 * Resolves: https://github.com/quantified-uncertainty/longterm-wiki/issues/920
 */

import { createRule, Issue, Severity } from '../validation/validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation/validation-engine.ts';

// Entity types that are abstract and cannot have an "Official Website"
const ABSTRACT_ENTITY_TYPES = new Set([
  'risk',
  'risk-factor',
  'capability',
  'approach',
  'crux',
  'concept',
  'case-study',
  'scenario',
  'historical',
  'analysis',
  'parameter',
  'metric',
  'argument',
  'table',
  'diagram',
  'debate',
  'overview',
  'policy',
  'safety-agenda',
  'intelligence-paradigm',
]);

export const officialWebsiteLabelRule = createRule({
  id: 'official-website-label',
  name: 'Official Website Label',
  description: 'Flag "Official Website" label for abstract entity types that cannot have one',

  check(content: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    const entityType = content.frontmatter?.entityType as string | undefined;
    if (!entityType || !ABSTRACT_ENTITY_TYPES.has(entityType)) {
      return issues; // Only flag abstract entity types
    }

    const body = content.body;
    const officialWebsitePattern = /\|\s*\*?\*?Official Website\*?\*?\s*\|/gi;

    let match: RegExpExecArray | null;
    officialWebsitePattern.lastIndex = 0;

    while ((match = officialWebsitePattern.exec(body)) !== null) {
      const linesBefore = body.substring(0, match.index).split('\n');
      const lineNumber = linesBefore.length;

      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        line: lineNumber,
        message: `'Official Website' label used on a '${entityType}' page — abstract entity types cannot have an official website. Use 'Related Resource' or 'See Also' instead.`,
        severity: Severity.WARNING,
      }));
    }

    return issues;
  },
});

export default officialWebsiteLabelRule;
