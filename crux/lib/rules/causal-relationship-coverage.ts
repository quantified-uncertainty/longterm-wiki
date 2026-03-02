/**
 * Rule: Causal Relationship Coverage
 *
 * Global-scope rule that extracts causal language patterns from prose
 * (e.g., "X causes Y", "X mitigates Y"), maps the terms to entity IDs
 * via title/alias matching, and checks whether those relationships
 * exist in entity data. Advisory only (INFO).
 *
 * Ported from crux/validate/validate-consistency.ts (lines ~347-423).
 */

import { createRule, Issue, Severity } from '../validation/validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation/validation-engine.ts';
import type { Entity } from '../content-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CausalPattern {
  regex: RegExp;
  type: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Causal claim patterns to extract from prose.
 * Use \w+(?:\s+\w+){0,5} instead of [\w\s]{2,30} to avoid catastrophic backtracking
 * ([\w\s] overlaps with \s+, causing exponential regex engine paths on large text).
 */
const CAUSAL_PATTERNS: CausalPattern[] = [
  { regex: /(\w+(?:\s+\w+){0,5})\s+(?:causes?|leads?\s+to|results?\s+in)\s+(\w+(?:\s+\w+){0,5})/gi, type: 'causes' },
  { regex: /(\w+(?:\s+\w+){0,5})\s+(?:mitigates?|prevents?|reduces?)\s+(\w+(?:\s+\w+){0,5})/gi, type: 'mitigates' },
  { regex: /(\w+(?:\s+\w+){0,5})\s+(?:enables?|allows?)\s+(\w+(?:\s+\w+){0,5})/gi, type: 'enables' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a lookup map from entity titles and aliases (lowercased) to entity IDs.
 */
function buildTitleToIdMap(entities: Entity[]): Map<string, string> {
  const titleToId = new Map<string, string>();
  for (const entity of entities) {
    titleToId.set(entity.title.toLowerCase(), entity.id);
    if (entity.aliases) {
      for (const alias of entity.aliases) {
        titleToId.set(alias.toLowerCase(), entity.id);
      }
    }
  }
  return titleToId;
}

/**
 * Build a set of known entity relationships (both directions) for fast lookup.
 * Keys are formatted as "sourceId:targetId".
 */
function buildRelationshipSet(entities: Entity[]): Set<string> {
  const relationships = new Set<string>();
  for (const entity of entities) {
    if (entity.relatedEntries) {
      for (const rel of entity.relatedEntries) {
        relationships.add(`${entity.id}:${rel.id}`);
      }
    }
  }
  return relationships;
}

// ---------------------------------------------------------------------------
// Rule export
// ---------------------------------------------------------------------------

export const causalRelationshipCoverageRule = createRule({
  id: 'causal-relationship-coverage',
  name: 'Causal Relationship Coverage',
  description: 'Flags causal claims in prose that lack matching entity relationships in data',
  scope: 'global',

  check(files: ContentFile | ContentFile[], engine: ValidationEngine): Issue[] {
    const allFiles = Array.isArray(files) ? files : [files];
    const issues: Issue[] = [];

    // Get entities from the engine
    const entities = (engine.entities ?? []) as Entity[];
    if (entities.length === 0) return issues;

    const titleToId = buildTitleToIdMap(entities);
    const relationships = buildRelationshipSet(entities);

    for (const contentFile of allFiles) {
      const body = contentFile.body;
      if (!body) continue;

      for (const { regex, type } of CAUSAL_PATTERNS) {
        // Reset regex state before each file
        regex.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = regex.exec(body)) !== null) {
          const [, sourceTerm, targetTerm] = match;

          // Try to match terms to entities
          const sourceId = titleToId.get(sourceTerm.trim().toLowerCase());
          const targetId = titleToId.get(targetTerm.trim().toLowerCase());

          if (sourceId && targetId && sourceId !== targetId) {
            // Check if relationship exists in entity data (either direction)
            const forwardKey = `${sourceId}:${targetId}`;
            const reverseKey = `${targetId}:${sourceId}`;

            if (!relationships.has(forwardKey) && !relationships.has(reverseKey)) {
              issues.push(new Issue({
                rule: 'causal-relationship-coverage',
                file: contentFile.path,
                message: `Causal claim "${sourceTerm.trim()} ${type} ${targetTerm.trim()}" not reflected in entity data. Consider adding relatedEntry from ${sourceId} to ${targetId} with relationship: "${type}".`,
                severity: Severity.INFO,
              }));
            }
          }
        }
      }
    }

    // Deduplicate by source/target/type triple
    const seen = new Set<string>();
    return issues.filter((issue: Issue) => {
      // Extract sourceId, targetId, and type from the message
      const relMatch = issue.message.match(/from (\S+) to (\S+) with relationship: "(\w+)"/);
      if (!relMatch) return true;
      const key = `${relMatch[1]}:${relMatch[2]}:${relMatch[3]}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
});

export default causalRelationshipCoverageRule;
