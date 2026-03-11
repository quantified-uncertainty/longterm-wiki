/**
 * Rule: Resource Reference Integrity
 *
 * Checks that all <R id="..."> components reference valid resource IDs.
 * Uses PG-first loading (falls back to snapshot when wiki-server is unavailable).
 */

import { createRule, Issue, Severity, type ContentFile, type ValidationEngine } from '../validation/validation-engine.ts';
import { loadResourceIdsPGFirst } from '../../resource-io.ts';

// Cache to avoid re-fetching on every file check
let resourceIdCache: Set<string> | null = null;

async function getResourceIds(): Promise<Set<string> | null> {
  if (resourceIdCache) return resourceIdCache;
  try {
    resourceIdCache = await loadResourceIdsPGFirst();
  } catch {
    // Neither PG nor snapshot available (e.g. CI without wiki-server).
    // Return null so the rule can skip gracefully.
    return null;
  }
  return resourceIdCache;
}

/** Regex matching <R id="HEXID"> or <R id='HEXID'> */
const RESOURCE_REF_RE = /<R\s+id=["']([^"']+)["'][^>]*>/g;

export const resourceRefIntegrityRule = createRule({
  id: 'resource-ref-integrity',
  name: 'Resource Reference Integrity',
  description: 'Verify all <R id="..."> components reference valid resource IDs',

  async check(content: ContentFile, _engine: ValidationEngine): Promise<Issue[]> {
    const issues: Issue[] = [];

    // Skip internal documentation pages (relativePath is relative to content/docs/)
    if (
      content.relativePath.startsWith('internal/') ||
      content.relativePath.includes('/internal/')
    ) {
      return issues;
    }

    const resourceIds = await getResourceIds();
    if (!resourceIds) return issues; // No resource data available — skip check
    const lines = content.body.split('\n');
    let inFencedBlock = false;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];

      // Track fenced code blocks (``` or ~~~)
      if (/^[ \t]*(`{3,}|~{3,})/.test(line)) {
        inFencedBlock = !inFencedBlock;
        continue;
      }
      if (inFencedBlock) continue;

      // Strip inline code spans before checking for <R> tags
      const strippedLine = line.replace(/`[^`]*`/g, '');

      RESOURCE_REF_RE.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = RESOURCE_REF_RE.exec(strippedLine)) !== null) {
        const id = match[1];
        if (!resourceIds.has(id)) {
          issues.push(new Issue({
            rule: 'resource-ref-integrity',
            file: content.path,
            line: lineIdx + 1,
            message: `<R id="${id}"> does not match any known resource`,
            severity: Severity.ERROR,
          }));
        }
      }
    }

    return issues;
  },
});

export default resourceRefIntegrityRule;
