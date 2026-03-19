/**
 * Migrate entity cross-references from slugs to stableIds in data/entities/*.yaml.
 *
 * Fields migrated:
 * - relatedEntries[].id
 * - stakeholders[].entityId
 * - keyPoliticians[].entityId
 * - parentOrg
 * - organization (on project entities)
 * - affiliationId (on person entities)
 *
 * Uses text-based replacement to preserve YAML formatting.
 */

import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";

const DATA_DIR = path.resolve("data/entities");

interface EntityEntry {
  id: string;
  stableId?: string;
  [key: string]: unknown;
}

// Build slug → stableId map from all entity YAML files
function buildSlugMap(): Map<string, string> {
  const map = new Map<string, string>();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".yaml"));
  for (const file of files) {
    const raw = fs.readFileSync(path.join(DATA_DIR, file), "utf-8");
    const data = parseYaml(raw) as EntityEntry[];
    if (!Array.isArray(data)) continue;
    for (const entity of data) {
      if (entity.id && entity.stableId) {
        map.set(entity.id, entity.stableId);
      }
    }
  }
  return map;
}

// Check if a string looks like a stableId (10-char alphanumeric)
function isStableId(s: string): boolean {
  return /^[A-Za-z0-9]{10}$/.test(s);
}

/**
 * Replace slug references with stableIds in a YAML file using text replacement.
 * Targets specific field patterns to avoid replacing the entity's own `id:` field.
 */
function migrateFile(
  filePath: string,
  slugMap: Map<string, string>,
  dryRun: boolean
): { replaced: number; unresolved: string[] } {
  let content = fs.readFileSync(filePath, "utf-8");
  let replaced = 0;
  const unresolved: string[] = [];

  // Pattern 1: relatedEntries[].id — "      - id: <slug>"
  // Match deeply-indented "- id:" lines (4+ spaces) that are part of relatedEntries arrays.
  // Top-level entity `- id:` lines use 0 or 2 spaces — those must NOT be replaced.
  content = content.replace(
    /^(    \s*- id: )([a-z][a-z0-9-]+)$/gm,
    (match, prefix, slug) => {
      if (isStableId(slug)) return match;
      const stableId = slugMap.get(slug);
      if (stableId) {
        replaced++;
        return `${prefix}${stableId}`;
      }
      unresolved.push(`relatedEntries.id: ${slug}`);
      return match;
    }
  );

  // Pattern 2: entityId: <slug> (stakeholders, keyPoliticians)
  content = content.replace(
    /^(\s+entityId: )([a-z][a-z0-9-]+)$/gm,
    (match, prefix, slug) => {
      if (isStableId(slug)) return match;
      const stableId = slugMap.get(slug);
      if (stableId) {
        replaced++;
        return `${prefix}${stableId}`;
      }
      unresolved.push(`entityId: ${slug}`);
      return match;
    }
  );

  // Pattern 3: parentOrg: <slug>
  content = content.replace(
    /^(\s+parentOrg: )([a-z][a-z0-9-]+)$/gm,
    (match, prefix, slug) => {
      if (isStableId(slug)) return match;
      const stableId = slugMap.get(slug);
      if (stableId) {
        replaced++;
        return `${prefix}${stableId}`;
      }
      unresolved.push(`parentOrg: ${slug}`);
      return match;
    }
  );

  // Pattern 4: organization: <slug> (project entities)
  content = content.replace(
    /^(\s+organization: )([a-z][a-z0-9-]+)$/gm,
    (match, prefix, slug) => {
      if (isStableId(slug)) return match;
      const stableId = slugMap.get(slug);
      if (stableId) {
        replaced++;
        return `${prefix}${stableId}`;
      }
      unresolved.push(`organization: ${slug}`);
      return match;
    }
  );

  // Pattern 5: affiliationId: <slug> (person entities)
  content = content.replace(
    /^(\s+affiliationId: )([a-z][a-z0-9-]+)$/gm,
    (match, prefix, slug) => {
      if (isStableId(slug)) return match;
      const stableId = slugMap.get(slug);
      if (stableId) {
        replaced++;
        return `${prefix}${stableId}`;
      }
      unresolved.push(`affiliationId: ${slug}`);
      return match;
    }
  );

  if (!dryRun && replaced > 0) {
    fs.writeFileSync(filePath, content, "utf-8");
  }

  return { replaced, unresolved };
}

// ── CLI ────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (command === "run" || command === "dry-run") {
  const dryRun = command === "dry-run" || args.includes("--dry-run");
  const slugMap = buildSlugMap();
  console.log(`Loaded ${slugMap.size} slug → stableId mappings\n`);

  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".yaml"));
  let totalReplaced = 0;
  const allUnresolved: string[] = [];

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    const { replaced, unresolved } = migrateFile(filePath, slugMap, dryRun);
    if (replaced > 0) {
      console.log(`  ${dryRun ? "[DRY] " : ""}${file}: ${replaced} references migrated`);
    }
    totalReplaced += replaced;
    allUnresolved.push(...unresolved.map(u => `${file}: ${u}`));
  }

  console.log(`\nTotal: ${totalReplaced} references migrated${dryRun ? " (dry run)" : ""}`);
  if (allUnresolved.length > 0) {
    console.log(`\nUnresolved (${allUnresolved.length}):`);
    for (const u of allUnresolved.slice(0, 20)) {
      console.log(`  ⚠ ${u}`);
    }
    if (allUnresolved.length > 20) {
      console.log(`  ... and ${allUnresolved.length - 20} more`);
    }
  }
} else {
  console.log("Usage: npx tsx crux/commands/migrate-entity-refs-to-stableids.ts <run|dry-run>");
}
