/**
 * Rule: EntityLink ID Validation
 *
 * Checks that all <EntityLink id="..."> components reference valid IDs
 * and follow the preferred format: numeric ID primary, optional name cross-check.
 *
 * Preferred format:
 *   <EntityLink id="E42" name="anthropic">Anthropic</EntityLink>
 *
 * Checks:
 * 1. ID resolves to a known entity (via pathRegistry, entities DB, or content file)
 * 2. Slug IDs should use numeric format instead (WARNING, auto-fixable)
 * 3. Numeric ID + name: validates name matches the entity's slug (ERROR if mismatch)
 * 4. Numeric ID without name: advisory (WARNING, auto-fixable)
 * 5. Unknown numeric ID: warning
 */

import { createRule, Issue, Severity, FixType, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { CONTENT_DIR_ABS as CONTENT_DIR } from '../content-types.ts';
import { ENTITY_LINK_RE, NUMERIC_ID_RE, extractEntityLinkName } from '../patterns.ts';
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
  description: 'Verify EntityLink IDs resolve to valid entities and use numeric+name format',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Skip internal documentation
    if (content.relativePath.includes('/internal/')) {
      return issues;
    }

    // Match <EntityLink id="..."> patterns — use the full tag match for name extraction
    const regex = new RegExp(ENTITY_LINK_RE.source, 'g');
    let match: RegExpExecArray | null;
    let lineNum = 0;
    const lines = content.body.split('\n');

    for (const line of lines) {
      lineNum++;
      regex.lastIndex = 0;

      while ((match = regex.exec(line)) !== null) {
        const fullTag = match[0];
        const rawId = match[1];
        const nameAttr = extractEntityLinkName(fullTag);

        // --- Numeric ID (E35) ---
        if (NUMERIC_ID_RE.test(rawId) && engine.idRegistry) {
          const slug = engine.idRegistry.byNumericId[rawId.toUpperCase()];
          if (slug) {
            // Numeric ID resolves — check name attribute
            if (nameAttr) {
              if (nameAttr !== slug) {
                // Name mismatch — ERROR (hallucination or stale reference)
                issues.push(new Issue({
                  rule: this.id,
                  file: content.path,
                  line: lineNum,
                  message: `EntityLink id="${rawId}" name="${nameAttr}" — name mismatch: ${rawId} is "${slug}", not "${nameAttr}"`,
                  severity: Severity.ERROR,
                  fix: {
                    type: FixType.REPLACE_TEXT,
                    oldText: `name="${nameAttr}"`,
                    newText: `name="${slug}"`,
                  },
                }));
              }
              // else: name matches — perfect, no issue
            } else {
              // Numeric ID without name — advisory warning with auto-fix
              issues.push(new Issue({
                rule: this.id,
                file: content.path,
                line: lineNum,
                message: `EntityLink id="${rawId}" — add name="${slug}" for cross-check`,
                severity: Severity.WARNING,
                fix: {
                  type: FixType.REPLACE_TEXT,
                  oldText: `id="${rawId}"`,
                  newText: `id="${rawId}" name="${slug}"`,
                },
              }));
            }
            continue; // Numeric ID is valid; skip path/entity resolution check
          } else {
            // Unknown numeric ID
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

        // --- Slug ID ---
        // Check if it resolves to an entity
        const id = rawId;
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
          continue;
        }

        // Slug resolves — suggest numeric+name format if numeric ID is available
        if (engine.idRegistry) {
          const numericId = engine.idRegistry.bySlug[id];
          if (numericId) {
            issues.push(new Issue({
              rule: this.id,
              file: content.path,
              line: lineNum,
              message: `EntityLink id="${rawId}" — use numeric format: id="${numericId}" name="${id}"`,
              severity: Severity.WARNING,
              fix: {
                type: FixType.REPLACE_TEXT,
                oldText: `id="${rawId}"`,
                newText: `id="${numericId}" name="${rawId}"`,
              },
            }));
          }
        }
      }
    }

    return issues;
  },
});

export default entityLinkIdsRule;
