#!/usr/bin/env node

/**
 * KB Entity Slug Validation — gate check for entity reference coverage.
 *
 * Scans FactBase YAML files (packages/factbase/data/things/) for entity
 * references (via !ref fact values) and validates that every referenced
 * entity has an entry in the local entity registry (data/entities/*.yaml).
 *
 * This catches entities that exist in the FactBase graph but are missing
 * from the TableBase entity declarations — meaning they won't appear in
 * directory pages, won't have stable IDs for URL resolution, and won't
 * be linkable from wiki pages.
 *
 * Checks:
 *   - Every !ref fact value's target stableId has a data/entities/*.yaml entry
 *   - Every FactBase entity file's own stableId has a data/entities/*.yaml entry
 *     (overlap with validate-factbase-entities.ts, included for completeness)
 *
 * Usage:
 *   npx tsx crux/validate/validate-kb-entity-slugs.ts              # report mode
 *   npx tsx crux/validate/validate-kb-entity-slugs.ts --fix         # auto-create missing entries
 *   npx tsx crux/validate/validate-kb-entity-slugs.ts --verbose     # show all refs
 *   npx tsx crux/validate/validate-kb-entity-slugs.ts --ci          # JSON output
 *
 * Exit codes:
 *   0 = All referenced entities have registry entries
 *   1 = Missing entries found (and not all fixed)
 */

import { readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MissingEntityRef {
  /** The stableId that is referenced but missing from entity registry */
  stableId: string;
  /** The FactBase YAML filename (slug) where this ref appears */
  sourceFile: string;
  /** The entity name from the FactBase graph (if available) */
  entityName?: string;
  /** The entity type from the FactBase graph (if available) */
  entityType?: string;
  /** The YAML slug of the referenced entity (derived from filenameMap) */
  slug?: string;
  /** Which fact property contains the reference */
  propertyId?: string;
  /** The owning entity's stableId */
  ownerStableId?: string;
  /** Whether this is the entity's own stableId (vs a ref in a fact) */
  isSelfRef: boolean;
}

export interface ValidationStats {
  totalFactbaseEntities: number;
  totalRefsChecked: number;
  totalRegistryEntities: number;
  missingCount: number;
  fixedCount: number;
}

// ---------------------------------------------------------------------------
// Entity registry loading (from data/entities/*.yaml)
// ---------------------------------------------------------------------------

interface EntityEntry {
  id?: string;
  stableId?: string;
  type?: string;
  title?: string;
  [key: string]: unknown;
}

/**
 * Load all stableIds, slugs, and titles from data/entities/*.yaml.
 * Returns sets/maps for entity lookup including a stableId→title map.
 */
export function loadEntityRegistry(
  entitiesDir: string
): {
  stableIds: Set<string>;
  slugToStableId: Map<string, string>;
  stableIdToSlug: Map<string, string>;
  stableIdToTitle: Map<string, string>;
} {
  const stableIds = new Set<string>();
  const slugToStableId = new Map<string, string>();
  const stableIdToSlug = new Map<string, string>();
  const stableIdToTitle = new Map<string, string>();

  let files: string[];
  try {
    files = readdirSync(entitiesDir).filter(
      (f) => extname(f) === ".yaml" || extname(f) === ".yml"
    );
  } catch {
    // Expected: directory may not exist in test fixtures or fresh checkouts
    return { stableIds, slugToStableId, stableIdToSlug, stableIdToTitle };
  }

  for (const file of files) {
    const content = readFileSync(join(entitiesDir, file), "utf-8");
    let parsed: unknown;
    try {
      parsed = parseYaml(content);
    } catch {
      // Malformed YAML — skip this file and continue with others
      continue;
    }

    const items: EntityEntry[] = Array.isArray(parsed)
      ? parsed
      : parsed
        ? [parsed as EntityEntry]
        : [];

    for (const entity of items) {
      if (!entity || typeof entity !== "object") continue;
      if (typeof entity.stableId === "string") {
        stableIds.add(entity.stableId);
        if (typeof entity.id === "string") {
          slugToStableId.set(entity.id, entity.stableId);
          stableIdToSlug.set(entity.stableId, entity.id);
        }
        if (typeof entity.title === "string" && entity.title.trim()) {
          stableIdToTitle.set(entity.stableId, entity.title.trim());
        }
      }
    }
  }

  return { stableIds, slugToStableId, stableIdToSlug, stableIdToTitle };
}

// ---------------------------------------------------------------------------
// FactBase scanning — extract all entity refs from YAML files
// ---------------------------------------------------------------------------

/**
 * Strip surrounding YAML quotes (single or double) from a value extracted
 * via regex. YAML quotes IDs that start with special characters (e.g. `-`),
 * but the logical value excludes the quotes.
 */
function stripYamlQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Extract the entity stableId from a FactBase YAML file.
 * Handles both entity: <stableId> and thing: { id: <stableId> } formats.
 */
function extractEntityId(content: string): string | null {
  const entityMatch = content.match(/^entity:\s*(\S+)/m);
  if (entityMatch && !content.match(/^thing:/m)) {
    return stripYamlQuotes(entityMatch[1]);
  }

  if (content.match(/^thing:/m)) {
    const stableIdMatch = content.match(/^\s+stableId:\s*(\S+)/m);
    if (stableIdMatch) return stripYamlQuotes(stableIdMatch[1]);

    const slugMatch = content.match(/^\s+slug:\s*\S+/m);
    if (slugMatch) {
      const idMatch = content.match(/^\s+id:\s*(\S+)/m);
      if (idMatch) return stripYamlQuotes(idMatch[1]);
    }
  }

  return null;
}

/**
 * Extract all !ref stableIds from a FactBase YAML file's raw content.
 * Returns pairs of (stableId, propertyId) for each reference found.
 */
export function extractRefValues(
  content: string
): Array<{ stableId: string; propertyId: string }> {
  const refs: Array<{ stableId: string; propertyId: string }> = [];

  const refRegex = /!ref\s+(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = refRegex.exec(content)) !== null) {
    let stableId = match[1];
    const colonIdx = stableId.indexOf(":");
    if (colonIdx > 0) {
      stableId = stableId.slice(0, colonIdx);
    }
    // Match sid_-prefixed stableIds
    if (/^sid_[A-Za-z0-9]{10}$/.test(stableId)) {
      const propertyId = findPropertyForRef(content, match.index);
      refs.push({ stableId, propertyId });
    }
  }

  return refs;
}

/**
 * Look backwards from a !ref match position to find the enclosing property: field.
 */
function findPropertyForRef(content: string, refPos: number): string {
  const before = content.slice(0, refPos);
  const lines = before.split("\n");

  for (let i = lines.length - 1; i >= 0; i--) {
    const propMatch = lines[i].match(/^\s+property:\s*(\S+)/);
    if (propMatch) return propMatch[1];
    if (lines[i].match(/^\s+-\s+id:/)) break;
  }

  return "(unknown)";
}

/**
 * Scan all FactBase YAML files and collect entity references.
 */
export function scanFactbaseRefs(thingsDir: string): {
  referencedStableIds: Map<string, MissingEntityRef[]>;
  entityStableIds: Map<string, { slug: string; name?: string; type?: string }>;
  totalRefs: number;
} {
  const referencedStableIds = new Map<string, MissingEntityRef[]>();
  const entityStableIds = new Map<string, { slug: string; name?: string; type?: string }>();
  let totalRefs = 0;

  let entries: string[];
  try {
    entries = readdirSync(thingsDir);
  } catch {
    // Expected: directory may not exist in test fixtures or fresh checkouts
    return { referencedStableIds, entityStableIds, totalRefs };
  }

  const yamlFiles = entries.filter(
    (e) => extname(e) === ".yaml" || extname(e) === ".yml"
  );

  for (const filename of yamlFiles) {
    const filePath = join(thingsDir, filename);
    const content = readFileSync(filePath, "utf-8");
    const slug = basename(filename, extname(filename));

    const entityId = extractEntityId(content);
    if (entityId) {
      let name: string | undefined;
      let type: string | undefined;

      // Only extract name/type from thing: format files (which have top-level
      // metadata fields). For entity: format files (all current production files),
      // indented name:/type: fields belong to nested fact values (e.g. type: range,
      // type: number) and would produce wrong entity types.
      const isThingFormat = /^thing:/m.test(content);
      if (isThingFormat) {
        const nameMatch = content.match(/^\s+name:\s*(.+)/m);
        if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
        const typeMatch = content.match(/^\s+type:\s*(\S+)/m);
        if (typeMatch) type = typeMatch[1];
      }

      entityStableIds.set(entityId, { slug, name, type });
    }

    const refs = extractRefValues(content);
    totalRefs += refs.length;

    for (const ref of refs) {
      if (!referencedStableIds.has(ref.stableId)) {
        referencedStableIds.set(ref.stableId, []);
      }
      referencedStableIds.get(ref.stableId)!.push({
        stableId: ref.stableId,
        sourceFile: filename,
        propertyId: ref.propertyId,
        ownerStableId: entityId ?? undefined,
        isSelfRef: false,
      });
    }
  }

  return { referencedStableIds, entityStableIds, totalRefs };
}

// ---------------------------------------------------------------------------
// Fix: create missing entity entries in YAML
// ---------------------------------------------------------------------------

function getTargetYamlFile(entityType: string): string {
  switch (entityType) {
    case "person":
      return "people.yaml";
    case "organization":
    case "lab":
    case "lab-academic":
    case "lab-research":
    case "lab-frontier":
      return "organizations.yaml";
    case "ai-model":
      return "ai-models.yaml";
    case "concept":
      return "concepts.yaml";
    case "risk":
      return "risks.yaml";
    case "approach":
    case "response":
      return "epistemic-orgs-projects.yaml";
    default:
      return "misc.yaml";
  }
}

function createEntityEntry(
  slug: string,
  stableId: string,
  entityType: string,
  name: string
): EntityEntry {
  return { id: slug, stableId, type: entityType, title: name };
}

export function fixMissingEntities(
  entitiesDir: string,
  missing: Array<{
    stableId: string;
    slug: string;
    entityType: string;
    name: string;
  }>
): number {
  const byFile = new Map<string, typeof missing>();
  for (const entry of missing) {
    const targetFile = getTargetYamlFile(entry.entityType);
    if (!byFile.has(targetFile)) byFile.set(targetFile, []);
    byFile.get(targetFile)!.push(entry);
  }

  let fixed = 0;

  for (const [filename, entries] of byFile) {
    const filePath = join(entitiesDir, filename);
    let existing: EntityEntry[] = [];

    try {
      const content = readFileSync(filePath, "utf-8");
      const parsed = parseYaml(content);
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      // File doesn't exist yet or is unparseable — will be created below
    }

    const existingStableIds = new Set(
      existing
        .filter((e) => typeof e?.stableId === "string")
        .map((e) => e.stableId as string)
    );

    const newEntries: EntityEntry[] = [];
    for (const entry of entries) {
      if (!existingStableIds.has(entry.stableId)) {
        newEntries.push(
          createEntityEntry(entry.slug, entry.stableId, entry.entityType, entry.name)
        );
      }
    }

    if (newEntries.length === 0) continue;

    // Append new entries as raw YAML to preserve existing comments and formatting.
    // stringify() strips YAML comments during roundtrip, so we avoid re-serializing
    // the entire file.
    const newYaml = stringifyYaml(newEntries, {
      lineWidth: 0,
      defaultStringType: "PLAIN",
      defaultKeyType: "PLAIN",
    });

    if (existsSync(filePath)) {
      // Ensure we start on a new line before appending
      const existingContent = readFileSync(filePath, "utf-8");
      const separator = existingContent.endsWith("\n") ? "" : "\n";
      appendFileSync(filePath, separator + newYaml);
    } else {
      writeFileSync(filePath, newYaml);
    }
    fixed += newEntries.length;
  }

  return fixed;
}

// ---------------------------------------------------------------------------
// Validation orchestration
// ---------------------------------------------------------------------------

export interface ValidationResult {
  missingRefs: MissingEntityRef[];
  uniqueMissing: Map<string, { stableId: string; slug: string; entityType: string; name: string }>;
  stats: ValidationStats;
}

export function validateKbEntitySlugs(
  entitiesDir: string,
  thingsDir: string,
  fixMode: boolean
): ValidationResult {
  const registry = loadEntityRegistry(entitiesDir);

  const { referencedStableIds, entityStableIds, totalRefs } =
    scanFactbaseRefs(thingsDir);

  const missingRefs: MissingEntityRef[] = [];
  const missingStableIds = new Set<string>();

  for (const [stableId, refs] of referencedStableIds) {
    if (!registry.stableIds.has(stableId)) {
      missingStableIds.add(stableId);
      const entityInfo = entityStableIds.get(stableId);
      for (const ref of refs) {
        ref.entityName = entityInfo?.name;
        ref.entityType = entityInfo?.type;
        ref.slug = entityInfo?.slug;
        missingRefs.push(ref);
      }
    }
  }

  for (const [stableId, info] of entityStableIds) {
    if (!registry.stableIds.has(stableId) && !missingStableIds.has(stableId)) {
      missingStableIds.add(stableId);
      missingRefs.push({
        stableId,
        sourceFile: `${info.slug}.yaml`,
        entityName: info.name,
        entityType: info.type,
        slug: info.slug,
        isSelfRef: true,
      });
    }
  }

  const uniqueMissing = new Map<
    string,
    { stableId: string; slug: string; entityType: string; name: string }
  >();
  for (const ref of missingRefs) {
    if (!uniqueMissing.has(ref.stableId)) {
      const slug =
        ref.slug ??
        registry.stableIdToSlug.get(ref.stableId) ??
        ref.stableId;
      uniqueMissing.set(ref.stableId, {
        stableId: ref.stableId,
        slug,
        entityType: ref.entityType ?? "concept",
        name: ref.entityName ?? slug,
      });
    }
  }

  const stats: ValidationStats = {
    totalFactbaseEntities: entityStableIds.size,
    totalRefsChecked: totalRefs,
    totalRegistryEntities: registry.stableIds.size,
    missingCount: uniqueMissing.size,
    fixedCount: 0,
  };

  if (fixMode && uniqueMissing.size > 0) {
    stats.fixedCount = fixMissingEntities(
      entitiesDir,
      [...uniqueMissing.values()]
    );
  }

  return { missingRefs, uniqueMissing, stats };
}

// ---------------------------------------------------------------------------
// Main (CLI entry point)
// ---------------------------------------------------------------------------

function main(): void {
  const verbose = process.argv.includes("--verbose");
  const ci = process.argv.includes("--ci");
  const fixMode = process.argv.includes("--fix");
  const c = getColors(ci);

  const entitiesDir = join(PROJECT_ROOT, "data", "entities");
  const thingsDir = join(PROJECT_ROOT, "packages", "factbase", "data", "things");

  const { missingRefs, uniqueMissing, stats } = validateKbEntitySlugs(
    entitiesDir,
    thingsDir,
    fixMode
  );

  if (ci) {
    const missingList = [...uniqueMissing.values()].map((m) => ({
      stableId: m.stableId,
      slug: m.slug,
      entityType: m.entityType,
      name: m.name,
    }));

    console.log(
      JSON.stringify({
        passed: uniqueMissing.size === 0 || stats.fixedCount === uniqueMissing.size,
        ...stats,
        missing: missingList,
      })
    );
  } else {
    console.log(
      `\n${c.bold}${c.blue}KB Entity Slug Validation${c.reset}\n`
    );
    console.log(`FactBase entities: ${stats.totalFactbaseEntities}`);
    console.log(`Entity registry entries: ${stats.totalRegistryEntities}`);
    console.log(`Total !ref values checked: ${stats.totalRefsChecked}`);
    console.log(
      `Missing from registry: ${stats.missingCount}${
        stats.fixedCount > 0 ? ` (${stats.fixedCount} fixed)` : ""
      }\n`
    );

    if (uniqueMissing.size > 0) {
      // Skip the missing-entries list when all were successfully fixed
      const allFixed = fixMode && stats.fixedCount === uniqueMissing.size;

      if (!allFixed) {
        const remaining = [...uniqueMissing.values()];
        const label = fixMode ? "Remaining" : "Missing";
        console.log(
          `${c.red}${c.bold}${label} entity registry entries:${c.reset}`
        );
        const toShow = verbose ? remaining : remaining.slice(0, 30);
        for (const m of toShow) {
          console.log(
            `  ${c.red}x${c.reset} ${m.stableId} (${m.entityType}) — slug: ${m.slug}, name: "${m.name}"`
          );
        }
        if (!verbose && remaining.length > 30) {
          console.log(
            `  ... and ${remaining.length - 30} more (use --verbose to see all)`
          );
        }
        console.log("");
      }

      if (fixMode && stats.fixedCount > 0) {
        console.log(
          `${c.green}Fixed ${stats.fixedCount} missing entries in data/entities/.${c.reset}\n`
        );
      }

      if (verbose && missingRefs.length > 0) {
        console.log(
          `${c.bold}References to missing entities:${c.reset}`
        );
        for (const ref of missingRefs) {
          const prop = ref.propertyId ? ` (property: ${ref.propertyId})` : "";
          const selfLabel = ref.isSelfRef ? " [self]" : "";
          console.log(
            `  ${ref.sourceFile}: ${ref.stableId}${prop}${selfLabel}`
          );
        }
        console.log("");
      }
    }

    if (uniqueMissing.size === 0) {
      console.log(
        `${c.green}All FactBase entity references have registry entries.${c.reset}`
      );
    } else if (fixMode && stats.fixedCount === uniqueMissing.size) {
      console.log(
        `${c.green}All ${stats.fixedCount} missing entries have been created.${c.reset}`
      );
    } else {
      const unfixed = uniqueMissing.size - stats.fixedCount;
      console.log(
        `${c.red}${unfixed} entity reference(s) missing from the registry.` +
          (fixMode ? "" : ` Run with --fix to auto-create entries.`) +
          `${c.reset}`
      );
    }
  }

  const unfixed = uniqueMissing.size - stats.fixedCount;
  if (unfixed > 0) {
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
