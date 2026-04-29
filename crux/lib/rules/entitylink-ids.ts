/**
 * Rule: EntityLink ID Validation
 *
 * Checks that all <EntityLink id="..."> components reference valid IDs
 * and follow the preferred format: wiki ID primary, optional name cross-check.
 *
 * Preferred format:
 *   <EntityLink id="E42" name="anthropic">Anthropic</EntityLink>
 *
 * Checks:
 * 1. ID resolves to a known entity (via pathRegistry, entities DB, or content file)
 * 2. Slug IDs should use numeric format instead (ERROR, auto-fixable from
 *    user-typed slug — safe)
 * 3. Bare numeric ID (e.g. "35"): normalize to E-prefix only (ERROR,
 *    auto-fixable; see QUA-761 — does not inject name= from registry)
 * 4. Wiki ID + name: validates name matches the entity's slug (ERROR if mismatch,
 *    NO auto-fix — see QUA-761)
 * 5. Wiki ID without name: advisory (WARNING, auto-fixable)
 * 6. Unknown wiki ID: warning
 */

import { createRule, Issue, Severity, FixType, type ContentFile, type ValidationEngine } from '../validation/validation-engine.ts';
import { CONTENT_DIR_ABS as CONTENT_DIR } from '../content-types.ts';
import { ENTITY_LINK_RE, WIKI_ID_RE, extractEntityLinkName } from '../patterns.ts';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Check if a path-style ID resolves to a real content file.
 * Mirrors the EntityLink fallback: `/knowledge-base/${id}/`
 */
function pathStyleIdResolvesToFile(id: string): boolean {
  // Only applies to IDs that look like paths (contain /)
  if (!id.includes('/')) return false;

  // Check knowledge-base top-level dir
  const prefixes = ['knowledge-base'];

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

        // --- Bare wiki ID (35 instead of E35) ---
        if (/^\d+$/.test(rawId)) {
          const eId = `E${rawId}`;
          const slug = engine.idRegistry?.byWikiId[eId];
          // Only normalize the E-prefix. Don't auto-inject name="${slug}" —
          // (a) if the wiki ID was reassigned the registry slug mismatches
          //     the prose (same hallucination as QUA-761's name-mismatch case),
          // (b) if the original tag already has a name= attribute, injecting
          //     produces a duplicate name= which breaks JSX compilation.
          // The next validation pass surfaces the missing-name advisory if
          // applicable, where the human can decide what to write.
          issues.push(new Issue({
            rule: this.id,
            file: content.path,
            line: lineNum,
            message: `EntityLink id="${rawId}" — bare wiki ID; use "${eId}"${slug ? ` (${slug})` : ''} instead`,
            severity: Severity.ERROR,
            fix: {
              type: FixType.REPLACE_TEXT,
              oldText: `id="${rawId}"`,
              newText: `id="${eId}"`,
            },
          }));
          continue;
        }

        // --- Wiki ID (E35) ---
        if (WIKI_ID_RE.test(rawId) && engine.idRegistry) {
          const slug = engine.idRegistry.byWikiId[rawId.toUpperCase()];
          if (slug) {
            // Wiki ID resolves — check name attribute
            if (nameAttr) {
              if (nameAttr !== slug) {
                // Name mismatch — ERROR. No auto-fix: the wiki ID may have been
                // reassigned to a different entity since the prose was written
                // (e.g., E3613 was Michael Kratsios, now Melania Trump). A
                // mechanical name=→slug rewrite would silently corrupt the
                // surrounding prose. Human judgment required.
                // engine.idRegistry is guaranteed non-null here (outer `if`).
                const idForCurrentName = engine.idRegistry.bySlug[nameAttr];
                const hint = idForCurrentName
                  ? ` (name "${nameAttr}" currently maps to ${idForCurrentName} — wiki ID may have been reassigned)`
                  : '';
                issues.push(new Issue({
                  rule: this.id,
                  file: content.path,
                  line: lineNum,
                  message: `EntityLink id="${rawId}" name="${nameAttr}" — name mismatch: ${rawId} is "${slug}", not "${nameAttr}"${hint}. Verify the prose and fix manually (no auto-fix: see QUA-761).`,
                  severity: Severity.ERROR,
                }));
              }
              // else: name matches — perfect, no issue
            } else {
              // Wiki ID without name — advisory warning with auto-fix
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
            continue; // Wiki ID is valid; skip path/entity resolution check
          } else {
            // Unknown wiki ID
            issues.push(new Issue({
              rule: this.id,
              file: content.path,
              line: lineNum,
              message: `EntityLink id="${rawId}" is not a registered wiki ID`,
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
          engine.pathRegistry[`__index__/${id}`]
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

        // Slug resolves — suggest numeric+name format if wiki ID is available
        if (engine.idRegistry) {
          const wikiId = engine.idRegistry.bySlug[id];
          if (wikiId) {
            issues.push(new Issue({
              rule: this.id,
              file: content.path,
              line: lineNum,
              message: `EntityLink id="${rawId}" — use numeric format: id="${wikiId}" name="${id}"`,
              severity: Severity.ERROR,
              fix: {
                type: FixType.REPLACE_TEXT,
                oldText: `id="${rawId}"`,
                newText: `id="${wikiId}" name="${rawId}"`,
              },
            }));
          }
        }
      }
    }

    return issues;
  },
});
