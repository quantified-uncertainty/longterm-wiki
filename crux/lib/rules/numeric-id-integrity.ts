/**
 * Numeric ID Integrity Validation Rule (global scope)
 *
 * Cross-file checks for numericId fields in MDX frontmatter:
 * 1. Format: must match /^E\d+$/ (e.g. "E123")
 * 2. Uniqueness: no two pages may claim the same numericId
 * 3. Entity conflict: page numericId must not collide with a YAML entity's numericId
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { NUMERIC_ID_RE } from '../patterns.ts';

export const numericIdIntegrityRule = {
  id: 'numeric-id-integrity',
  name: 'Numeric ID Integrity',
  description: 'Detect duplicate, malformed, or conflicting numericId values across all pages',
  scope: 'global' as const,

  check(files: ContentFile | ContentFile[], engine: ValidationEngine): Issue[] {
    const contentFiles = Array.isArray(files) ? files : [files];
    const issues: Issue[] = [];

    // Map: numericId → first file that claimed it
    const seen = new Map<string, { file: string; slug: string }>();

    // Load the entity ID registry to detect entity conflicts
    const entityRegistry = engine.idRegistry?.byNumericId || {};

    for (const cf of contentFiles) {
      const numericId = cf.frontmatter.numericId as string | undefined;
      if (!numericId) continue;

      // 1. Format check
      if (!NUMERIC_ID_RE.test(numericId)) {
        issues.push(new Issue({
          rule: 'numeric-id-integrity',
          file: cf.path,
          line: 1,
          message: `numericId "${numericId}" has invalid format — must match E followed by digits (e.g. "E710")`,
          severity: Severity.ERROR,
        }));
        continue;
      }

      // 2. Cross-page uniqueness
      const prev = seen.get(numericId);
      if (prev) {
        issues.push(new Issue({
          rule: 'numeric-id-integrity',
          file: cf.path,
          line: 1,
          message: `numericId ${numericId} is also claimed by "${prev.slug}" — each page must have a unique numericId`,
          severity: Severity.ERROR,
        }));
      } else {
        seen.set(numericId, { file: cf.path, slug: cf.slug });
      }

      // 3. Entity conflict: if the id-registry maps this numericId to a different slug
      // Skip legitimate aliases where an entity renders at a differently-named page
      // (e.g. entity "tmc-epistemics" → page "epistemics")
      const entitySlug = entityRegistry[numericId];
      const pageSlug = cf.slug.split('/').pop() || cf.slug;
      if (entitySlug && entitySlug !== pageSlug) {
        // Check if entity slug contains the page slug (e.g. "tmc-epistemics" → "epistemics")
        // or vice versa — these are generated stubs, not real conflicts
        const isAlias = entitySlug.endsWith(`-${pageSlug}`) || pageSlug.endsWith(`-${entitySlug}`);
        // Index pages generate __index__/<path> entities — these are the same entity
        const isIndexEntity = entitySlug.startsWith('__index__');
        if (!isAlias && !isIndexEntity) {
          issues.push(new Issue({
            rule: 'numeric-id-integrity',
            file: cf.path,
            line: 1,
            message: `numericId ${numericId} conflicts with YAML entity "${entitySlug}" — assign a new numericId to this page`,
            severity: Severity.ERROR,
          }));
        }
      }
    }

    return issues;
  },
};
