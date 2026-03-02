/**
 * Rule: Person (OrgName) Affiliation Pattern
 *
 * Flags inline affiliation annotations like "Paul Christiano (ARC)" or
 * "Ajeya Cotra (Coefficient Giving)" in prose and table cells. This pattern
 * is fragile: affiliations change, it duplicates information from the person's
 * own page, and causes stale-affiliation bugs.
 *
 * The correct approach is to use EntityLink to the person and let the person's
 * page carry their affiliation context.
 *
 * Detection strategy: look for "First Last (Org)" patterns where the person
 * name converts to a registered entity slug (e.g. "paul-christiano" exists in
 * the path registry). The org check is intentionally loose — we flag whenever
 * the person name matches a known entity, regardless of the org string.
 *
 * Severity: WARNING (advisory — some edge cases like `(ed.)` may be intentional)
 *
 * Resolves: https://github.com/quantified-uncertainty/longterm-wiki/issues/922
 */

import { createRule, Issue, Severity } from '../validation/validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation/validation-engine.ts';
import { loadPathRegistry } from '../content-types.ts';

/** Convert display name to likely entity slug: "Paul Christiano" → "paul-christiano" */
function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Slugs that should be excluded even if they match the pattern (e.g. org names, not people) */
const EXCLUDE_SLUGS = new Set([
  'ai', 'ml', 'agi', 'llm', 'us', 'uk', 'eu', 'gpt', 'arc',
]);

// Parenthetical patterns that are never affiliation annotations:
const NON_AFFILIATION_PARENS = [
  /^\d+/,         // (2024) dates
  /^e\.g\./i,     // (e.g. ...)
  /^i\.e\./i,     // (i.e. ...)
  /^ed\.\)/i,     // (ed.)
  /^eds?\./i,     // (ed. or eds.)
  /^ibid/i,       // (ibid)
  /^sic\b/i,      // (sic)
  /^[A-Z]{1,5}s?$/, // short acronyms: (AI), (ML), (US), (RSPs), (LLMs)
  /^\$\d/,           // ($3B)
  /^£\d/,            // (£1M)
  /^€\d/,            // (€2M)
  /^~\d/,            // (~50%)
  /^\d+%/,           // (50%)
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i, // month names
  /^(The |A |An )/,  // book/resource titles starting with articles
  /^Independent$/i,  // "Independent researcher" abbreviation
  /^et al/i,         // citation suffix
  /\bdonation\b/i,   // "($10M donation)"
  /\bco-founder\b/i, // "(Skype co-founder)"
  /\bfounder\b/i,    // "(founder of ...)"
];

let pathRegistryCache: Record<string, string> | null = null;

function getPathRegistry(): Record<string, string> {
  if (pathRegistryCache) return pathRegistryCache;
  pathRegistryCache = loadPathRegistry();
  return pathRegistryCache;
}

export const personOrgAffiliationRule = createRule({
  id: 'person-org-affiliation',
  name: 'Person (OrgName) Affiliation Pattern',
  description: 'Flag inline "Person (OrgName)" affiliation annotations where the person is a registered entity — use EntityLink instead',

  check(content: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Skip internal docs (they may document the pattern)
    const rel = content.relativePath;
    if (rel.startsWith('internal/')) return issues;

    const body = content.body;
    const pathRegistry = getPathRegistry();

    // Pattern: "First Last (Something)" where Something is 2-40 chars,
    // not starting with a digit or common non-affiliation prefix.
    // Capture groups: 1=full person name, 2=parenthetical content
    const pattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+\(([^)]{2,40})\)/g;

    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;

    while ((match = pattern.exec(body)) !== null) {
      const personName = match[1];
      const parenContent = match[2].trim();

      // Skip if the parenthetical is clearly not an affiliation
      if (NON_AFFILIATION_PARENS.some(re => re.test(parenContent))) continue;

      // Skip if paren content contains lowercase/special chars suggesting it's
      // part of normal prose (e.g. "co-founder", "born in", "PhD candidate")
      if (/^[a-z]/.test(parenContent)) continue;
      if (parenContent.includes(' and ') || parenContent.includes(' at ')) continue;

      // Check if the person name maps to a registered entity
      const personSlug = nameToSlug(personName);
      if (EXCLUDE_SLUGS.has(personSlug)) continue;
      if (!(personSlug in pathRegistry)) continue;

      // Only flag when the entity at that slug is a person/researcher
      // (not concepts, orgs, models, etc.) to avoid false positives
      const entityPath = pathRegistry[personSlug];
      const isPerson = entityPath.includes('/people/') ||
                       entityPath.includes('/researchers/') ||
                       entityPath.includes('/staff/');
      if (!isPerson) continue;

      const lineNum = body.substring(0, match.index).split('\n').length;

      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        line: lineNum,
        message: `Found "${personName} (${parenContent})" — inline affiliation annotations are fragile. Use <EntityLink id="${personSlug}">${personName}</EntityLink> and let the person's page carry affiliation context.`,
        severity: Severity.WARNING,
      }));
    }

    return issues;
  },
});

export default personOrgAffiliationRule;
