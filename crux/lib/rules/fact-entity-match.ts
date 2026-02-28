/**
 * Rule: Fact Entity Match
 *
 * Validates that <F e="X"> components reference the page's own entity or
 * a closely related entity. Catches enrichment pipeline bugs where fact
 * references are attributed to the wrong entity (e.g., ARC page wrapping
 * ELK Prize amounts as Anthropic facts).
 *
 * How it determines the page's entity:
 *   The page slug is derived from the filename (e.g., "anthropic" from
 *   "anthropic.mdx"). If a fact file exists for that slug in data/facts/,
 *   then the page "owns" that entity. Cross-entity references are flagged
 *   as warnings so humans can verify they're intentional.
 *
 * Resolves: https://github.com/quantified-uncertainty/longterm-wiki/issues/1272
 */

import { existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { createRule, Issue, Severity } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';
import { PROJECT_ROOT } from '../content-types.ts';

const FACTS_DIR = join(PROJECT_ROOT, 'data/facts');

/** Cached set of entity slugs with fact files */
let _factEntitySlugs: Set<string> | null = null;

/**
 * Get all entity slugs that have fact files (i.e., entities that have
 * canonical facts defined in data/facts/*.yaml).
 */
function getFactEntitySlugs(): Set<string> {
  if (_factEntitySlugs) return _factEntitySlugs;
  try {
    if (!existsSync(FACTS_DIR)) {
      _factEntitySlugs = new Set();
      return _factEntitySlugs;
    }
    const files: string[] = readdirSync(FACTS_DIR).filter((f: string) => f.endsWith('.yaml'));
    _factEntitySlugs = new Set(files.map((f: string) => f.replace('.yaml', '')));
    return _factEntitySlugs;
  } catch {
    _factEntitySlugs = new Set();
    return _factEntitySlugs;
  }
}

/**
 * Derive the page's entity slug from its file path.
 * e.g., "knowledge-base/organizations/anthropic.mdx" -> "anthropic"
 */
function getPageEntitySlug(content: ContentFile): string {
  return basename(content.relativePath).replace(/\.(mdx?|md)$/, '');
}

/**
 * Pages that are explicitly comparison/cross-entity by nature.
 * These legitimately reference facts from multiple entities.
 */
const CROSS_ENTITY_SLUGS = new Set([
  'anthropic-valuation',     // Compares Anthropic vs OpenAI valuations
  'ftx-collapse-ea-funding-lessons', // Cross-references multiple orgs
  'directory',               // Index pages
]);

export const factEntityMatchRule = createRule({
  id: 'fact-entity-match',
  name: 'Fact Entity Match',
  description: 'Flag <F> components referencing facts from a different entity than the page\'s own entity',

  check(content: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Skip internal/ pages (documentation, dashboards)
    const rel = content.relativePath;
    if (rel.startsWith('internal/')) return issues;

    const pageSlug = getPageEntitySlug(content);

    // Skip known cross-entity comparison pages
    if (CROSS_ENTITY_SLUGS.has(pageSlug)) return issues;

    const factEntitySlugs = getFactEntitySlugs();

    // If the page's slug doesn't match any fact entity, the page is about
    // a topic that doesn't have its own facts (e.g., a person page or a
    // concept page). Cross-entity fact references are expected on such pages.
    const pageHasOwnFacts = factEntitySlugs.has(pageSlug);

    const body = content.body;
    if (!body) return issues;

    // Match <F e="entity" ...> components (both paired and self-closing)
    const fPattern = /<F\s[^>]*\be=["']([^"']+)["'][^>]*>/gi;
    let match: RegExpExecArray | null;
    fPattern.lastIndex = 0;

    while ((match = fPattern.exec(body)) !== null) {
      const factEntity = match[1].trim();

      // If the fact entity matches the page slug, all good
      if (factEntity === pageSlug) continue;

      // If the page doesn't have its own facts, cross-entity refs are expected
      // (e.g., a person page referencing their organization's facts)
      if (!pageHasOwnFacts) continue;

      // The fact entity doesn't match the page's own entity
      const linesBefore = body.substring(0, match.index).split('\n');
      const lineNumber = linesBefore.length;

      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        line: lineNumber,
        message: `<F e="${factEntity}"> references entity "${factEntity}" on page "${pageSlug}". ` +
          `Expected e="${pageSlug}" for facts about this entity. ` +
          `If this cross-reference is intentional, this warning can be ignored.`,
        severity: Severity.WARNING,
      }));
    }

    return issues;
  },
});

export default factEntityMatchRule;
