/**
 * Wiki ID Integrity Validation Rule (global scope)
 *
 * Cross-file checks for wikiId fields in MDX frontmatter:
 * 1. Format: must match /^E\d+$/ (e.g. "E123")
 * 2. Uniqueness: no two pages may claim the same wikiId
 * 3. Entity conflict: page wikiId must not collide with a YAML entity's wikiId
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation/validation-engine.ts';
import { WIKI_ID_RE } from '../patterns.ts';

export const wikiIdIntegrityRule = {
  id: 'wiki-id-integrity',
  name: 'Wiki ID Integrity',
  description: 'Detect duplicate, malformed, or conflicting wikiId values across all pages',
  scope: 'global' as const,

  check(files: ContentFile | ContentFile[], engine: ValidationEngine): Issue[] {
    const contentFiles = Array.isArray(files) ? files : [files];
    const issues: Issue[] = [];

    // Map: wikiId → first file that claimed it
    const seen = new Map<string, { file: string; slug: string }>();

    // Load the entity ID registry to detect entity conflicts
    const entityRegistry = engine.idRegistry?.byWikiId || {};

    for (const cf of contentFiles) {
      const wikiId = cf.frontmatter.wikiId as string | undefined;
      if (!wikiId) continue;

      // 1. Format check
      if (!WIKI_ID_RE.test(wikiId)) {
        issues.push(new Issue({
          rule: 'wiki-id-integrity',
          file: cf.path,
          line: 1,
          message: `wikiId "${wikiId}" has invalid format — must match E followed by digits (e.g. "E710")`,
          severity: Severity.ERROR,
        }));
        continue;
      }

      // 2. Cross-page uniqueness
      const prev = seen.get(wikiId);
      if (prev) {
        issues.push(new Issue({
          rule: 'wiki-id-integrity',
          file: cf.path,
          line: 1,
          message: `wikiId ${wikiId} is also claimed by "${prev.slug}" — each page must have a unique wikiId`,
          severity: Severity.ERROR,
        }));
      } else {
        seen.set(wikiId, { file: cf.path, slug: cf.slug });
      }

      // 3. Entity conflict: if the id-registry maps this wikiId to a different slug
      // Skip legitimate aliases where an entity renders at a differently-named page
      // (e.g. entity "tmc-epistemics" → page "epistemics")
      const entitySlug = entityRegistry[wikiId];
      const pageSlug = cf.slug.split('/').pop() || cf.slug;
      if (entitySlug && entitySlug !== pageSlug) {
        // Check if entity slug contains the page slug (e.g. "tmc-epistemics" → "epistemics")
        // or vice versa — these are generated stubs, not real conflicts
        const isAlias = entitySlug.endsWith(`-${pageSlug}`) || pageSlug.endsWith(`-${entitySlug}`);
        // Index pages generate __index__/<path> entities — these are the same entity
        const isIndexEntity = entitySlug.startsWith('__index__');
        if (!isAlias && !isIndexEntity) {
          issues.push(new Issue({
            rule: 'wiki-id-integrity',
            file: cf.path,
            line: 1,
            message: `wikiId ${wikiId} conflicts with YAML entity "${entitySlug}" — assign a new wikiId to this page`,
            severity: Severity.ERROR,
          }));
        }
      }
    }

    return issues;
  },
};
