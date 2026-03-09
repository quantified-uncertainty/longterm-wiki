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
// undefined = not yet attempted; null = load failed; Set = loaded successfully

let entitySlugCache: Set<string> | null | undefined = undefined;
let propertyIdCache: Set<string> | null | undefined = undefined;

export function loadEntitySlugs(): Set<string> | null {
  if (entitySlugCache !== undefined) return entitySlugCache;
  const loaded = new Set<string>();
  try {
    const files = readdirSync(KB_THINGS_DIR).filter((f) => f.endsWith('.yaml'));
    for (const file of files) {
      loaded.add(file.replace(/\.yaml$/, ''));
    }
    entitySlugCache = loaded;
  } catch {
    // KB things dir doesn't exist or is unreadable — signal to callers to skip validation
    entitySlugCache = null;
  }
  return entitySlugCache;
}

export function loadPropertyIds(): Set<string> | null {
  if (propertyIdCache !== undefined) return propertyIdCache;
  const loaded = new Set<string>();
  try {
    const raw = readFileSync(KB_PROPERTIES_FILE, 'utf-8');
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === 'object' && 'properties' in parsed) {
      const props = (parsed as { properties: Record<string, unknown> }).properties;
      if (props && typeof props === 'object') {
        for (const key of Object.keys(props)) {
          loaded.add(key);
        }
      }
    }
    propertyIdCache = loaded;
  } catch {
    // Properties file doesn't exist or is unparsable — signal to callers to skip validation
    propertyIdCache = null;
  }
  return propertyIdCache;
}

// ── Regex patterns ───────────────────────────────────────────────────────────

/**
 * Match <KBF ...> or <KBF ... /> with entity and property attributes in either
 * order. Uses [^>]+ so it naturally spans newlines (newlines are not '>'),
 * enabling multiline MDX components to be validated correctly.
 */
const KBF_TAG_RE = /<KBF\s+([^>]+?)>/g;
const ENTITY_ATTR_RE = /entity=["']([^"']+)["']/;
const PROPERTY_ATTR_RE = /property=["']([^"']+)["']/;

/**
 * Match <Calc expr="..." ...> and extract the expr value.
 * [^>]* spans newlines for the same reason as KBF_TAG_RE.
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

    // Skip validation if KB metadata could not be loaded (avoids false violations)
    if (entitySlugs === null || propertyIds === null) {
      return issues;
    }

    // Build unfenced body: fenced block contents replaced with empty lines to
    // preserve line offsets. Inline code spans are also stripped. Running the
    // regexes against the full body (rather than line-by-line) ensures that
    // multiline MDX components like:
    //   <KBF
    //     entity="anthropic"
    //     property="valuation"
    //   />
    // are matched and validated correctly.
    const lines = content.body.split('\n');
    const unfencedLines: string[] = [];
    let inFencedBlock = false;

    for (const line of lines) {
      if (/^[ \t]*(`{3,}|~{3,})/.test(line)) {
        inFencedBlock = !inFencedBlock;
        unfencedLines.push('');
        continue;
      }
      if (inFencedBlock) {
        unfencedLines.push('');
      } else {
        unfencedLines.push(line.replace(/`[^`]*`/g, ''));
      }
    }

    const unfencedBody = unfencedLines.join('\n');

    // Helper: 1-based line number for a match at byte offset `index`
    const lineAt = (index: number): number =>
      unfencedBody.slice(0, index).split('\n').length;

    // ── Check <KBF> tags ──────────────────────────────────────────
    KBF_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = KBF_TAG_RE.exec(unfencedBody)) !== null) {
      const attrString = match[1];
      const entityMatch = ENTITY_ATTR_RE.exec(attrString);
      const propertyMatch = PROPERTY_ATTR_RE.exec(attrString);
      const lineIdx = lineAt(match.index);

      if (entityMatch) {
        const entity = entityMatch[1];
        if (!entitySlugs.has(entity)) {
          issues.push(new Issue({
            rule: 'kbf-refs',
            file: content.path,
            line: lineIdx,
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
            line: lineIdx,
            message: `<KBF property="${property}"> does not match any property in packages/kb/data/properties.yaml`,
            severity: Severity.ERROR,
          }));
        }
      }
    }

    // ── Check <Calc> expressions ──────────────────────────────────
    CALC_EXPR_RE.lastIndex = 0;

    while ((match = CALC_EXPR_RE.exec(unfencedBody)) !== null) {
      const expr = match[1];
      const lineIdx = lineAt(match.index);

      CALC_REF_RE.lastIndex = 0;
      let refMatch: RegExpExecArray | null;

      while ((refMatch = CALC_REF_RE.exec(expr)) !== null) {
        const entity = refMatch[1];
        const property = refMatch[2];

        if (!entitySlugs.has(entity)) {
          issues.push(new Issue({
            rule: 'kbf-refs',
            file: content.path,
            line: lineIdx,
            message: `<Calc> references entity "${entity}" which does not match any KB entity in packages/kb/data/things/`,
            severity: Severity.ERROR,
          }));
        }

        if (!propertyIds.has(property)) {
          issues.push(new Issue({
            rule: 'kbf-refs',
            file: content.path,
            line: lineIdx,
            message: `<Calc> references property "${property}" which does not match any property in packages/kb/data/properties.yaml`,
            severity: Severity.ERROR,
          }));
        }
      }
    }

    return issues;
  },
});

export default kbfRefsRule;
