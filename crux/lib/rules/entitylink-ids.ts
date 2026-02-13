/**
 * Rule: EntityLink ID Validation
 *
 * Checks that all <EntityLink id="..."> components reference valid IDs
 * that exist in either the pathRegistry or entities database.
 *
 * Supports two ID formats:
 * 1. Simple entity IDs: "deceptive-alignment", "anthropic"
 *    → Resolved via pathRegistry or entities database
 * 2. Path-style IDs: "capabilities/agentic-ai", "risks/accident/scheming"
 *    → Resolved by checking if /knowledge-base/{id}/ maps to a real content file
 *
 * The EntityLink component at runtime falls back to `/knowledge-base/${id}/`
 * for unrecognized IDs, so path-style IDs work if the content exists.
 */

import { createRule, Issue, Severity, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { CONTENT_DIR_ABS as CONTENT_DIR } from '../content-types.ts';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Check if a path-style ID resolves to a real content file.
 * Mirrors the EntityLink fallback: `/knowledge-base/${id}/`
 */
function pathStyleIdResolvesToFile(id: string): boolean {
  // Only applies to IDs that look like paths (contain /)
  if (!id.includes('/')) return false;

  // Check both knowledge-base and ai-transition-model top-level dirs
  const prefixes = ['knowledge-base', 'ai-transition-model'];

  for (const prefix of prefixes) {
    const possiblePaths = [
      join(CONTENT_DIR, prefix, id + '.mdx'),
      join(CONTENT_DIR, prefix, id + '.md'),
      join(CONTENT_DIR, prefix, id, 'index.mdx'),
      join(CONTENT_DIR, prefix, id, 'index.md'),
    ];

    for (const p of possiblePaths) {
      if (existsSync(p)) return true;
    }
  }

  // Also check without prefix (the ID itself may include the full content path)
  const directPaths = [
    join(CONTENT_DIR, id + '.mdx'),
    join(CONTENT_DIR, id + '.md'),
    join(CONTENT_DIR, id, 'index.mdx'),
    join(CONTENT_DIR, id, 'index.md'),
  ];

  for (const p of directPaths) {
    if (existsSync(p)) return true;
  }

  return false;
}

export const entityLinkIdsRule = createRule({
  id: 'entitylink-ids',
  name: 'EntityLink ID Validation',
  description: 'Verify EntityLink IDs resolve to valid paths or entities',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Skip internal documentation
    if (content.relativePath.includes('/internal/')) {
      return issues;
    }

    // Match <EntityLink id="..."> patterns
    const regex = /<EntityLink\s+[^>]*id=["']([^"']+)["'][^>]*>/g;
    let match: RegExpExecArray | null;
    let lineNum = 0;
    const lines = content.body.split('\n');

    for (const line of lines) {
      lineNum++;
      regex.lastIndex = 0;

      while ((match = regex.exec(line)) !== null) {
        const rawId = match[1];

        // Resolve numeric IDs (E35 → slug) before validation
        let id = rawId;
        if (/^E\d+$/i.test(rawId) && engine.idRegistry) {
          const slug = engine.idRegistry.byNumericId[rawId.toUpperCase()];
          if (slug) {
            id = slug;
          } else {
            issues.push(new Issue({
              rule: this.id,
              file: content.path,
              line: lineNum,
              message: `EntityLink id="${rawId}" is not a registered numeric ID`,
              severity: Severity.WARNING,
            }));
            continue;
          }
        }

        // Check if ID exists in pathRegistry or entities
        const inPathRegistry = engine.pathRegistry && (
          engine.pathRegistry[id] ||
          engine.pathRegistry[`__index__/${id}`] ||
          engine.pathRegistry[`__index__/ai-transition-model/factors/${id}`]
        );
        const inEntities = engine.entities && (engine.entities as Record<string, unknown>)[id];
        const resolvesViaPath = pathStyleIdResolvesToFile(id);

        if (!inPathRegistry && !inEntities && !resolvesViaPath) {
          issues.push(new Issue({
            rule: this.id,
            file: content.path,
            line: lineNum,
            message: `EntityLink id="${rawId}" does not resolve to any known path or entity`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
});

export default entityLinkIdsRule;
