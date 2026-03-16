/**
 * Infrastructure Dimension Scanner for Entity Types
 *
 * Scans the codebase to determine which entity types have code-level support
 * across seven infrastructure dimensions: Zod schema, build pipeline,
 * type guard, ontology entry, directory page, profile page, and test files.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "./content-types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InfraDimensions {
  hasZodSchema: boolean;
  hasBuildPipeline: boolean;
  hasTypeGuard: boolean;
  hasOntologyEntry: boolean;
  hasDirectoryPage: boolean;
  hasProfilePage: boolean;
  hasTestFiles: boolean;
  infraScore: number; // 0-100
}

// ---------------------------------------------------------------------------
// File cache — avoids repeated I/O for the same source files
// ---------------------------------------------------------------------------

const fileCache = new Map<string, string>();

function readCached(absPath: string): string {
  const cached = fileCache.get(absPath);
  if (cached !== undefined) return cached;
  if (!existsSync(absPath)) {
    fileCache.set(absPath, "");
    return "";
  }
  const content = readFileSync(absPath, "utf-8");
  fileCache.set(absPath, content);
  return content;
}

// ---------------------------------------------------------------------------
// Canonical entity type list (parsed from entity-type-names.ts)
// ---------------------------------------------------------------------------

let _canonicalTypes: string[] | null = null;

function getCanonicalTypes(): string[] {
  if (_canonicalTypes) return _canonicalTypes;

  const src = readCached(
    join(PROJECT_ROOT, "apps/web/src/data/entity-type-names.ts")
  );
  // Extract the CANONICAL_ENTITY_TYPE_NAMES array entries
  const match = src.match(
    /CANONICAL_ENTITY_TYPE_NAMES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/
  );
  if (!match) {
    _canonicalTypes = [];
    return _canonicalTypes;
  }
  _canonicalTypes = Array.from(match[1].matchAll(/"([^"]+)"/g)).map(
    (m) => m[1]
  );
  return _canonicalTypes;
}

// ---------------------------------------------------------------------------
// Dimension checkers
// ---------------------------------------------------------------------------

/**
 * Dimension 1: hasZodSchema
 * True if entity-schemas.ts contains a z.literal("type") for this entity type.
 */
function checkZodSchema(entityType: string): boolean {
  const src = readCached(
    join(PROJECT_ROOT, "apps/web/src/data/entity-schemas.ts")
  );
  // Look for z.literal("entityType") — this is how per-type schemas declare their type
  return src.includes(`z.literal("${entityType}")`);
}

/**
 * Dimension 2: hasBuildPipeline
 * True if entity-transform.mjs has a switch case or explicit handling for the type.
 */
function checkBuildPipeline(entityType: string): boolean {
  const src = readCached(
    join(PROJECT_ROOT, "apps/web/scripts/lib/entity-transform.mjs")
  );
  // The switch in transformEntity uses case 'type': lines
  return src.includes(`case '${entityType}':`);
}

/**
 * Dimension 3: hasTypeGuard
 * True if an `is<PascalCase>(...)` function is exported in entity-schemas.ts.
 */
function checkTypeGuard(entityType: string): boolean {
  const src = readCached(
    join(PROJECT_ROOT, "apps/web/src/data/entity-schemas.ts")
  );
  const pascalCase = entityType
    .split("-")
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join("");
  return src.includes(`export function is${pascalCase}(`);
}

/**
 * Dimension 4: hasOntologyEntry
 * True if the type appears in the CANONICAL_ENTITY_TYPE_NAMES array.
 */
function checkOntologyEntry(entityType: string): boolean {
  return getCanonicalTypes().includes(entityType);
}

// ---------------------------------------------------------------------------
// Directory / profile page mapping
//
// Entity types map to directory routes. We use a known mapping plus a
// fallback heuristic (pluralize the type slug).
// ---------------------------------------------------------------------------

/**
 * Known entity type → directory route name mappings.
 * These cover cases where simple pluralisation would be wrong.
 */
const ENTITY_TYPE_TO_ROUTE: Record<string, string> = {
  person: "people",
  policy: "legislation",
  "ai-model": "ai-models",
  benchmark: "benchmarks",
  organization: "organizations",
  risk: "risks",
  project: "projects",
  "research-area": "research-areas",
};

/**
 * Pluralise a kebab-case slug with basic English rules.
 * Only used as a fallback when no explicit mapping exists.
 */
function pluralizeSlug(slug: string): string {
  if (slug.endsWith("y") && !slug.endsWith("ey")) {
    return slug.slice(0, -1) + "ies";
  }
  if (slug.endsWith("s") || slug.endsWith("x") || slug.endsWith("sh")) {
    return slug + "es";
  }
  return slug + "s";
}

function getRouteCandidates(entityType: string): string[] {
  const candidates: string[] = [];
  const explicit = ENTITY_TYPE_TO_ROUTE[entityType];
  if (explicit) candidates.push(explicit);
  candidates.push(pluralizeSlug(entityType));
  // Also try the raw type name (for routes that match exactly)
  candidates.push(entityType);
  return [...new Set(candidates)];
}

/**
 * Dimension 5: hasDirectoryPage
 * True if a page.tsx exists at the root of a matching route directory.
 */
function checkDirectoryPage(entityType: string): boolean {
  const appDir = join(PROJECT_ROOT, "apps/web/src/app");
  for (const route of getRouteCandidates(entityType)) {
    const pagePath = join(appDir, route, "page.tsx");
    if (existsSync(pagePath)) {
      // Check it's a real directory page, not just a redirect
      const content = readCached(pagePath);
      // A redirect-only page is still "a page exists" but not a real directory
      // We consider it a directory page if it has meaningful content (table, list, etc.)
      // or if it simply exists (even redirects indicate the route is claimed)
      // For strictness: exclude pure redirects
      if (
        content.includes("permanentRedirect") ||
        content.includes("redirect(")
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Dimension 6: hasProfilePage
 * True if a [slug] or [id] directory exists under a matching route.
 */
function checkProfilePage(entityType: string): boolean {
  const appDir = join(PROJECT_ROOT, "apps/web/src/app");
  for (const route of getRouteCandidates(entityType)) {
    const routeDir = join(appDir, route);
    if (!existsSync(routeDir)) continue;
    try {
      const entries = readdirSync(routeDir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          (entry.name.startsWith("[") && entry.name.endsWith("]"))
        ) {
          return true;
        }
      }
    } catch {
      // Directory not readable — skip
    }
  }
  return false;
}

/**
 * Dimension 7: hasTestFiles
 * True if any test file in the codebase references this entity type.
 * Searches both the app test files and crux test files.
 */
function checkTestFiles(entityType: string): boolean {
  const appDir = join(PROJECT_ROOT, "apps/web/src/app");
  // Check for test files in entity-type-specific route directories
  for (const route of getRouteCandidates(entityType)) {
    const routeDir = join(appDir, route);
    if (!existsSync(routeDir)) continue;
    // Look for .test.ts/.test.tsx files or __tests__ directories
    if (hasTestFilesInDir(routeDir)) return true;
  }

  // Also check for type-specific test files in data/__tests__
  const dataTestDir = join(appDir, "../data/__tests__");
  if (existsSync(dataTestDir)) {
    if (dirContainsTypeReference(dataTestDir, entityType)) return true;
  }

  return false;
}

function hasTestFilesInDir(dir: string): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx"))
      ) {
        return true;
      }
      if (entry.isDirectory() && entry.name === "__tests__") {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

function dirContainsTypeReference(dir: string, entityType: string): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx"))
      ) {
        const content = readCached(join(dir, entry.name));
        if (content.includes(`"${entityType}"`) || content.includes(`'${entityType}'`)) {
          return true;
        }
      }
    }
  } catch {
    // ignore
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan infrastructure dimensions for a single entity type.
 */
export function scanInfraDimensions(entityType: string): InfraDimensions {
  const dims = {
    hasZodSchema: checkZodSchema(entityType),
    hasBuildPipeline: checkBuildPipeline(entityType),
    hasTypeGuard: checkTypeGuard(entityType),
    hasOntologyEntry: checkOntologyEntry(entityType),
    hasDirectoryPage: checkDirectoryPage(entityType),
    hasProfilePage: checkProfilePage(entityType),
    hasTestFiles: checkTestFiles(entityType),
    infraScore: 0,
  };

  const trueCount = [
    dims.hasZodSchema,
    dims.hasBuildPipeline,
    dims.hasTypeGuard,
    dims.hasOntologyEntry,
    dims.hasDirectoryPage,
    dims.hasProfilePage,
    dims.hasTestFiles,
  ].filter(Boolean).length;

  dims.infraScore = Math.round((trueCount / 7) * 100);
  return dims;
}

/**
 * Scan infrastructure dimensions for all canonical entity types.
 * Returns a Map keyed by entity type name.
 */
export function scanAllInfraDimensions(): Map<string, InfraDimensions> {
  const result = new Map<string, InfraDimensions>();
  for (const entityType of getCanonicalTypes()) {
    result.set(entityType, scanInfraDimensions(entityType));
  }
  return result;
}
