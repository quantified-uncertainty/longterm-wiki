#!/usr/bin/env tsx
/**
 * Add stableId fields to entity YAML entries using KB thing file mappings.
 *
 * Prerequisites for Phase 0e (relatedEntries migration) of the Unified things Table plan (#2169).
 *
 * Usage:
 *   pnpm tsx crux/scripts/add-stableids-to-entity-yaml.ts          # dry-run
 *   pnpm tsx crux/scripts/add-stableids-to-entity-yaml.ts --apply  # write changes
 */

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const THINGS_DIR = "packages/factbase/data/things";
const ENTITIES_DIR = "data/entities";
const apply = process.argv.includes("--apply");

// Step 1: Build slug → stableId mapping from KB thing files
const slugToStableId = new Map<string, string>();
for (const file of readdirSync(THINGS_DIR)) {
  if (!file.endsWith(".yaml")) continue;
  const slug = file.replace(".yaml", "");
  const content = readFileSync(join(THINGS_DIR, file), "utf-8");
  const match = content.match(/stableId:\s+(\S+)/);
  if (match) {
    slugToStableId.set(slug, match[1]);
  }
}
console.log(`Loaded ${slugToStableId.size} slug→stableId mappings from KB thing files`);

// Step 2: Process each entity YAML file
let totalEntities = 0;
let added = 0;
let alreadyHas = 0;
let noMapping = 0;
const missingMappings: string[] = [];

for (const file of readdirSync(ENTITIES_DIR).sort()) {
  if (!file.endsWith(".yaml")) continue;
  const filePath = join(ENTITIES_DIR, file);
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const newLines: string[] = [];
  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    newLines.push(line);

    // Match entity entry start: "- id: slug"
    const idMatch = line.match(/^- id:\s+(.+)$/);
    if (!idMatch) continue;

    totalEntities++;
    const slug = idMatch[1].trim();

    // Check if next line already has stableId
    const nextLine = lines[i + 1] || "";
    if (nextLine.match(/^\s+stableId:/)) {
      alreadyHas++;
      continue;
    }

    const stableId = slugToStableId.get(slug);
    if (!stableId) {
      noMapping++;
      missingMappings.push(slug);
      continue;
    }

    // Insert stableId after the id line (before numericId or other fields)
    newLines.push(`  stableId: ${stableId}`);
    added++;
    modified = true;
  }

  if (modified && apply) {
    writeFileSync(filePath, newLines.join("\n"));
  }
}

console.log(`\nResults:`);
console.log(`  Total entities: ${totalEntities}`);
console.log(`  stableId added: ${added}`);
console.log(`  Already had stableId: ${alreadyHas}`);
console.log(`  No mapping available: ${noMapping}`);

if (missingMappings.length > 0 && missingMappings.length <= 20) {
  console.log(`\nMissing mappings: ${missingMappings.join(", ")}`);
} else if (missingMappings.length > 20) {
  console.log(`\nMissing mappings (first 20): ${missingMappings.slice(0, 20).join(", ")}`);
  console.log(`  ... and ${missingMappings.length - 20} more`);
}

if (!apply) {
  console.log(`\nDry run — pass --apply to write changes`);
} else {
  console.log(`\nChanges written to ${ENTITIES_DIR}/*.yaml`);
}
