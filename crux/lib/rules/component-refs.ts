/**
 * Rule: Component Reference Validation
 *
 * Validates that components reference data that actually exists:
 * - EntityLink id="..." references valid entities
 * - DataInfoBox entityId="..." references valid entities
 * - DataExternalLinks pageId="..." has matching external links data
 *
 * Also checks for unused imports.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { createRule, Issue, Severity, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { loadDatabase, loadPathRegistry, loadIdRegistry as loadIdReg, DATA_DIR_ABS, type Entity } from '../content-types.ts';
import { NUMERIC_ID_RE, ENTITY_LINK_RE } from '../patterns.ts';

const DATA_DIR = DATA_DIR_ABS;

// Cache for loaded data
let entitiesCache: Set<string> | null = null;
let externalLinksCache: Set<string> | null = null;
let safetyApproachesCache: Set<string> | null = null;
let idRegistryCache: Record<string, string> | null = null;

/** Load numeric-ID → slug mapping from database.json */
function loadIdRegistry(): Record<string, string> {
  if (idRegistryCache) return idRegistryCache;
  try {
    idRegistryCache = loadIdReg().byNumericId;
    return idRegistryCache;
  } catch {
    idRegistryCache = {};
    return idRegistryCache;
  }
}

/** Resolve a numeric ID (E35) to its slug, or return the ID unchanged */
function resolveNumericId(id: string): string {
  if (NUMERIC_ID_RE.test(id)) {
    const registry = loadIdRegistry();
    return registry[id] || id;
  }
  return id;
}

function loadEntities(): Set<string> {
  if (entitiesCache) return entitiesCache;
  try {
    const database = loadDatabase();
    entitiesCache = new Set();

    // Entities are stored as typedEntities in database.json (raw entities stripped by build-data)
    const entities = (database as any).typedEntities || database.entities || [];
    if (Array.isArray(entities)) {
      for (const entity of entities) {
        if (entity && entity.id) {
          entitiesCache.add(entity.id);
        }
      }
    } else {
      // Fallback for object format
      for (const entity of Object.values(entities as Record<string, Entity>)) {
        if (entity && entity.id) {
          entitiesCache.add(entity.id);
        }
      }
    }

    // Also add IDs from pathRegistry (more comprehensive)
    const pathRegistry = loadPathRegistry();
    for (const [id, path] of Object.entries(pathRegistry)) {
      entitiesCache.add(id);
      // Also index by path segments so EntityLink id="capabilities/agentic-ai" matches
      // pathRegistry value "/knowledge-base/capabilities/agentic-ai/"
      if (typeof path === 'string') {
        const stripped = path.replace(/^\//, '').replace(/\/$/, '');
        entitiesCache.add(stripped);
        // Also add without the top-level prefix (e.g., "knowledge-base/capabilities/x" -> "capabilities/x")
        const withoutPrefix = stripped.replace(/^knowledge-base\//, '');
        if (withoutPrefix !== stripped) {
          entitiesCache.add(withoutPrefix);
        }
      }
    }

    return entitiesCache;
  } catch {
    return new Set();
  }
}

function loadExternalLinks(): Set<string> {
  if (externalLinksCache) return externalLinksCache;
  try {
    const content = readFileSync(`${DATA_DIR}/external-links.yaml`, 'utf-8');
    const pageIds = new Set<string>();
    const matches = content.matchAll(/^- pageId: (.+)$/gm);
    for (const match of matches) {
      pageIds.add(match[1].trim());
    }
    externalLinksCache = pageIds;
    return pageIds;
  } catch {
    return new Set();
  }
}

function loadSafetyApproaches(): Set<string> {
  if (safetyApproachesCache) return safetyApproachesCache;
  try {
    const content = readFileSync(`${DATA_DIR}/tables/safety-approaches.ts`, 'utf-8');
    const ids = new Set<string>();
    const matches = content.matchAll(/id: ['"]([^'"]+)['"]/g);
    for (const match of matches) {
      ids.add(match[1]);
    }
    safetyApproachesCache = ids;
    return ids;
  } catch {
    return new Set();
  }
}

function parseImports(content: string): Array<{ components: string[]; source: string; fullMatch: string; index: number }> {
  const imports: Array<{ components: string[]; source: string; fullMatch: string; index: number }> = [];
  const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    const components = match[1].split(',').map(c => c.trim()).filter(Boolean);
    imports.push({
      components,
      source: match[2],
      fullMatch: match[0],
      index: match.index,
    });
  }

  return imports;
}

function findUnusedImports(content: string, imports: Array<{ components: string[]; source: string; fullMatch: string; index: number }>): Array<{ component: string; source: string }> {
  const unused: Array<{ component: string; source: string }> = [];

  for (const imp of imports) {
    for (const component of imp.components) {
      const afterImport = content.slice(imp.index + imp.fullMatch.length);
      const usagePattern = new RegExp(`<${component}[\\s/>]|${component}\\(`);

      if (!usagePattern.test(afterImport)) {
        unused.push({ component, source: imp.source });
      }
    }
  }

  return unused;
}

export const componentRefsRule = createRule({
  id: 'component-refs',
  name: 'Component Reference Validation',
  description: 'Verify EntityLink, DataInfoBox, etc. reference valid data',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const raw = content.raw;
    const body = content.body;

    // Skip internal documentation (except for unused imports check)
    const isInternalDoc = content.relativePath.includes('/internal/');

    // Load data sources
    const entities = loadEntities();
    const externalLinks = loadExternalLinks();
    const safetyApproaches = loadSafetyApproaches();

    // Check for unused imports
    const imports = parseImports(raw);
    const unused = findUnusedImports(raw, imports);

    for (const u of unused) {
      issues.push(new Issue({
        rule: this.id,
        file: content.path,
        message: `Unused import: ${u.component} from "${u.source}"`,
        severity: Severity.WARNING,
      }));
    }

    // Check EntityLink references (skip for internal docs)
    if (!isInternalDoc) {
      for (const match of body.matchAll(ENTITY_LINK_RE)) {
        const rawId = match[1];
        const id = resolveNumericId(rawId);
        const lineNum = body.slice(0, match.index).split('\n').length;

        const isValid = entities.has(id) ||
                        safetyApproaches.has(id) ||
                        id.startsWith('__index__/') ||
                        entities.has(`__index__/${id}`) ||
                        entities.has(`__index__/ai-transition-model/factors/${id}`);

        if (!isValid) {
          issues.push(new Issue({
            rule: this.id,
            file: content.path,
            line: lineNum,
            message: `EntityLink id="${rawId}" not found in entities or safety-approaches`,
            severity: Severity.ERROR,
          }));
        }
      }
    }

    // Check DataInfoBox references (skip for internal docs)
    if (!isInternalDoc) {
      const infoBoxRegex = /<DataInfoBox\s+entityId=["']([^"']+)["']/g;
      let match: RegExpExecArray | null;
      while ((match = infoBoxRegex.exec(body)) !== null) {
        const rawId = match[1];
        const id = resolveNumericId(rawId);
        const lineNum = body.slice(0, match.index).split('\n').length;

        if (!entities.has(id)) {
          issues.push(new Issue({
            rule: this.id,
            file: content.path,
            line: lineNum,
            message: `DataInfoBox entityId="${rawId}" not found in entities`,
            severity: Severity.ERROR,
          }));
        }
      }
    }

    // Check DataExternalLinks references (skip for internal docs)
    if (!isInternalDoc) {
      const externalLinksRegex = /<DataExternalLinks\s+pageId=["']([^"']+)["']/g;
      let match: RegExpExecArray | null;
      while ((match = externalLinksRegex.exec(body)) !== null) {
        const id = match[1];
        const lineNum = body.slice(0, match.index).split('\n').length;

        if (!externalLinks.has(id)) {
          issues.push(new Issue({
            rule: this.id,
            file: content.path,
            line: lineNum,
            message: `DataExternalLinks pageId="${id}" has no entries in external-links.yaml`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
});

export default componentRefsRule;
