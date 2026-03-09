/**
 * Rule: KBF Cross-Reference Integrity
 *
 * Checks that all <KBF entity="..." property="..."> and <Calc expr="{entity.property}">
 * components reference valid KB entity slugs and property IDs.
 *
 * Entity slugs come from packages/kb/data/things/ directory listing (each .yaml
 * file basename minus extension = entity slug).
 *
 * Property IDs come from packages/kb/data/properties.yaml (all keys under the
 * top-level `properties:` mapping).
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { createRule, Issue, Severity, type ContentFile, type ValidationEngine } from '../validation/validation-engine.ts';
import { PROJECT_ROOT } from '../content-types.ts';

const KB_THINGS_DIR = join(PROJECT_ROOT, 'packages/kb/data/things');
const KB_PROPERTIES_FILE = join(PROJECT_ROOT, 'packages/kb/data/properties.yaml');

// ── Caches (populated on first use, like resource-ref-integrity) ─────────────

let entitySlugCache: Set<string> | null = null;
let propertyIdCache: Set<string> | null = null;

export function loadEntitySlugs(): Set<string> {
  if (entitySlugCache) return entitySlugCache;
  entitySlugCache = new Set<string>();
  try {
    const files = readdirSync(KB_THINGS_DIR).filter((f) => f.endsWith('.yaml'));
    for (const file of files) {
      entitySlugCache.add(file.replace(/\.yaml$/, ''));
    }
  } catch {
    // skip if KB things dir doesn't exist
  }
  return entitySlugCache;
}

export function loadPropertyIds(): Set<string> {
  if (propertyIdCache) return propertyIdCache;
  propertyIdCache = new Set<string>();
  try {
    const raw = readFileSync(KB_PROPERTIES_FILE, 'utf-8');
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === 'object' && 'properties' in parsed) {
      const props = (parsed as { properties: Record<string, unknown> }).properties;
      if (props && typeof props === 'object') {
        for (const key of Object.keys(props)) {
          propertyIdCache.add(key);
        }
      }
    }
  } catch {
    // skip if properties file doesn't exist or is unparsable
  }
  return propertyIdCache;
}

// ── Regex patterns ───────────────────────────────────────────────────────────

/**
 * Match <KBF ...> or <KBF ... /> with entity and property attributes in either
 * order. Uses a single regex that captures all attributes, then extracts
 * entity/property from the attribute string.
 */
const KBF_TAG_RE = /<KBF\s+([^>]+?)>/g;
const ENTITY_ATTR_RE = /entity=["']([^"']+)["']/;
const PROPERTY_ATTR_RE = /property=["']([^"']+)["']/;

/**
 * Match <Calc expr="..." ...> and extract the expr value.
 */
const CALC_EXPR_RE = /<Calc\s+[^>]*expr=["']([^"']+)["'][^>]*>/g;

/**
 * Within a Calc expr, match {entity.property} references.
 */
const CALC_REF_RE = /\{([^.}]+)\.([^}]+)\}/g;

export const kbfRefsRule = createRule({
  id: 'kbf-refs',
  name: 'KBF Cross-Reference Integrity',
  description: 'Verify all <KBF entity="..." property="..."> and <Calc expr="{entity.property}"> reference valid KB entities and properties',

  check(content: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Skip internal documentation pages
    if (
      content.relativePath.startsWith('internal/') ||
      content.relativePath.includes('/internal/')
    ) {
      return issues;
    }

    const entitySlugs = loadEntitySlugs();
    const propertyIds = loadPropertyIds();
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

      // Strip inline code spans before checking
      const strippedLine = line.replace(/`[^`]*`/g, '');

      // ── Check <KBF> tags ──────────────────────────────────────────
      KBF_TAG_RE.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = KBF_TAG_RE.exec(strippedLine)) !== null) {
        const attrString = match[1];
        const entityMatch = ENTITY_ATTR_RE.exec(attrString);
        const propertyMatch = PROPERTY_ATTR_RE.exec(attrString);

        if (entityMatch) {
          const entity = entityMatch[1];
          if (!entitySlugs.has(entity)) {
            issues.push(new Issue({
              rule: 'kbf-refs',
              file: content.path,
              line: lineIdx + 1,
              message: `<KBF entity="${entity}"> does not match any KB entity in packages/kb/data/things/`,
              severity: Severity.ERROR,
            }));
          }
        }

        if (propertyMatch) {
          const property = propertyMatch[1];
          if (!propertyIds.has(property)) {
            issues.push(new Issue({
              rule: 'kbf-refs',
              file: content.path,
              line: lineIdx + 1,
              message: `<KBF property="${property}"> does not match any property in packages/kb/data/properties.yaml`,
              severity: Severity.WARNING,
            }));
          }
        }
      }

      // ── Check <Calc> expressions ──────────────────────────────────
      CALC_EXPR_RE.lastIndex = 0;

      while ((match = CALC_EXPR_RE.exec(strippedLine)) !== null) {
        const expr = match[1];

        CALC_REF_RE.lastIndex = 0;
        let refMatch: RegExpExecArray | null;

        while ((refMatch = CALC_REF_RE.exec(expr)) !== null) {
          const entity = refMatch[1];
          const property = refMatch[2];

          if (!entitySlugs.has(entity)) {
            issues.push(new Issue({
              rule: 'kbf-refs',
              file: content.path,
              line: lineIdx + 1,
              message: `<Calc> references entity "${entity}" which does not match any KB entity in packages/kb/data/things/`,
              severity: Severity.ERROR,
            }));
          }

          if (!propertyIds.has(property)) {
            issues.push(new Issue({
              rule: 'kbf-refs',
              file: content.path,
              line: lineIdx + 1,
              message: `<Calc> references property "${property}" which does not match any property in packages/kb/data/properties.yaml`,
              severity: Severity.WARNING,
            }));
          }
        }
      }
    }

    return issues;
  },
});

export default kbfRefsRule;
