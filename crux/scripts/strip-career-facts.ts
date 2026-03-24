/**
 * Removes employed-by and role facts from FactBase YAML files.
 *
 * Career records belong in the personnel table (TableBase), not FactBase.
 * This script strips employed-by and role facts while preserving biographical
 * facts (born-year, education, notable-for, social-media, etc.).
 *
 * Usage:
 *   node --import tsx/esm crux/scripts/strip-career-facts.ts [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const THINGS_DIR = join(ROOT, "packages/factbase/data/things");
const dryRun = process.argv.includes("--dry-run");

// Properties that are career/employment data → remove from FactBase
const CAREER_PROPERTIES = new Set(["employed-by", "role"]);

let filesModified = 0;
let filesDeleted = 0;
let factsRemoved = 0;
let factsKept = 0;

for (const filename of readdirSync(THINGS_DIR).filter((f) => f.endsWith(".yaml"))) {
  const filePath = join(THINGS_DIR, filename);
  const content = readFileSync(filePath, "utf-8");

  // Parse the file manually to handle !ref tags
  // Split into entity line and facts
  const entityMatch = content.match(/^entity: (.+)/m);
  if (!entityMatch) continue;
  const entityId = entityMatch[1];

  // Extract individual fact blocks
  const factBlocks: string[] = [];
  const careerFactBlocks: string[] = [];

  // Split by "  - id:" pattern (each fact starts with this)
  const rawBlocks = content.split(/(?=  - id:)/);
  for (const block of rawBlocks) {
    if (!block.includes("- id:")) continue;

    // Check if this fact has a career property
    const propMatch = block.match(/property:\s*"?([^"\n]+)"?/);
    if (propMatch && CAREER_PROPERTIES.has(propMatch[1])) {
      careerFactBlocks.push(block);
      factsRemoved++;
    } else {
      factBlocks.push(block);
      factsKept++;
    }
  }

  if (careerFactBlocks.length === 0) continue; // No career facts to remove

  if (factBlocks.length === 0) {
    // File would be empty (only had career facts) — check if it's a person file
    // that was created just for career data. If the only facts were career facts,
    // we might want to keep the file with just the entity ID for other facts
    // to be added later. But if it literally has nothing, flag it.
    if (dryRun) {
      console.log(`[DRY RUN] ${filename}: would remove ${careerFactBlocks.length} career facts (file would have 0 remaining facts)`);
    } else {
      // Write a minimal file with just the entity header
      writeFileSync(filePath, `entity: ${entityId}\nfacts: []\n`);
    }
    filesModified++;
    continue;
  }

  if (dryRun) {
    console.log(`[DRY RUN] ${filename}: remove ${careerFactBlocks.length} career facts, keep ${factBlocks.length} biographical facts`);
    filesModified++;
    continue;
  }

  // Reconstruct the file
  const newContent = `entity: ${entityId}\nfacts:\n${factBlocks.join("")}`;
  writeFileSync(filePath, newContent);
  filesModified++;
}

console.log("\n── Summary ──");
console.log(`Files modified: ${filesModified}`);
console.log(`Career facts removed: ${factsRemoved}`);
console.log(`Biographical facts kept: ${factsKept}`);

if (dryRun) {
  console.log("\n[DRY RUN] No files were modified.");
}
