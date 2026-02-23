/**
 * Rule: Resource Reference Integrity
 *
 * Checks that all <R id="..."> components reference valid resource IDs
 * from data/resources/*.yaml files.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { createRule, Issue, Severity, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { DATA_DIR_ABS } from '../content-types.ts';

const RESOURCES_DIR = join(DATA_DIR_ABS, 'resources');

// Cache to avoid re-reading YAML on every file check
let resourceIdCache: Set<string> | null = null;

function loadResourceIds(): Set<string> {
  if (resourceIdCache) return resourceIdCache;
  resourceIdCache = new Set<string>();
  try {
    const files = readdirSync(RESOURCES_DIR).filter((f) => f.endsWith('.yaml'));
    for (const file of files) {
      try {
        const raw = readFileSync(join(RESOURCES_DIR, file), 'utf-8');
        const entries = parseYaml(raw);
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (entry && typeof entry.id === 'string' && entry.id) {
              resourceIdCache.add(entry.id);
            }
          }
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // skip if resources dir doesn't exist
  }
  return resourceIdCache;
}

/** Regex matching <R id="HEXID"> or <R id='HEXID'> */
const RESOURCE_REF_RE = /<R\s+id=["']([^"']+)["'][^>]*>/g;

export const resourceRefIntegrityRule = createRule({
  id: 'resource-ref-integrity',
  name: 'Resource Reference Integrity',
  description: 'Verify all <R id="..."> components reference valid resource IDs in data/resources/',

  check(content: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Skip internal documentation pages (relativePath is relative to content/docs/)
    if (
      content.relativePath.startsWith('internal/') ||
      content.relativePath.includes('/internal/')
    ) {
      return issues;
    }

    const resourceIds = loadResourceIds();
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
            message: `<R id="${id}"> does not match any resource in data/resources/*.yaml`,
            severity: Severity.ERROR,
          }));
        }
      }
    }

    return issues;
  },
});

export default resourceRefIntegrityRule;
