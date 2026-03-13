/**
 * Rule: KBF Cross-Reference Integrity
 *
 * Checks that all <KBF entity="..." property="..."> and <Calc expr="{entity.property}">
 * components reference valid KB entity identifiers (slugs or stableIds) and property IDs.
 *
 * Entity identifiers come from packages/kb/data/things/ — both the YAML filename
 * (slug) and the thing.stableId field inside each file are accepted.
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

let entityIdCache: Set<string> | null | undefined = undefined;
let propertyIdCache: Set<string> | null | undefined = undefined;

/**
 * Load all valid entity identifiers: both slugs (from filenames) and stableIds
 * (from thing.stableId inside each YAML file).
 */
export function loadEntitySlugs(): Set<string> | null {
  if (entityIdCache !== undefined) return entityIdCache;
  const loaded = new Set<string>();
  try {
    const entries = readdirSync(KB_THINGS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.yaml')) {
        const slug = entry.name.replace(/\.yaml$/, '');
        loaded.add(slug);
        // Also extract stableId from the YAML file so that both slugs and
        // stableIds are accepted as valid entity identifiers in MDX components.
        try {
          const raw = readFileSync(join(KB_THINGS_DIR, entry.name), 'utf-8');
          const parsed = parseYaml(raw);
          const stableId = parsed?.thing?.stableId;
          if (typeof stableId === 'string' && stableId) {
            loaded.add(stableId);
          }
        } catch {
          // Individual file parse failure — slug is still valid, skip stableId
        }
      } else if (entry.isDirectory()) {
        // Per-entity directory: look for entity.yaml or any file with a thing: block
        const slug = entry.name;
        loaded.add(slug);
        try {
          const dirFiles = readdirSync(join(KB_THINGS_DIR, entry.name)).filter(f => f.endsWith('.yaml'));
          for (const f of dirFiles) {
            try {
              const raw = readFileSync(join(KB_THINGS_DIR, entry.name, f), 'utf-8');
              const parsed = parseYaml(raw);
              const stableId = parsed?.thing?.stableId;
              if (typeof stableId === 'string' && stableId) {
                loaded.add(stableId);
                break; // Found the entity file, no need to check more
              }
            } catch {
              // Skip unparseable files
            }
          }
        } catch {
          // Directory read failed — slug is still valid
        }
      }
    }
    entityIdCache = loaded;
  } catch {
    // KB things dir doesn't exist or is unreadable — signal to callers to skip validation
    entityIdCache = null;
  }
  return entityIdCache;
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

/** Reset caches for testing purposes. */
export function _resetCache(): void {
  entityIdCache = undefined;
  propertyIdCache = undefined;
}

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

    const entityIds = loadEntitySlugs();
    const propertyIds = loadPropertyIds();

    // Skip validation if KB metadata could not be loaded (avoids false violations)
    if (entityIds === null || propertyIds === null) {
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
        if (!entityIds.has(entity)) {
          issues.push(new Issue({
            rule: 'kbf-refs',
            file: content.path,
            line: lineIdx,
            message: `<KBF entity="${entity}"> does not match any KB entity slug or stableId in packages/kb/data/things/`,
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

        if (!entityIds.has(entity)) {
          issues.push(new Issue({
            rule: 'kbf-refs',
            file: content.path,
            line: lineIdx,
            message: `<Calc> references entity "${entity}" which does not match any KB entity slug or stableId in packages/kb/data/things/`,
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
