/**
 * One-time migration: add `sid_` prefix to all entity stableIds in YAML files.
 *
 * Targets:
 * 1. data/entities/*.yaml      — `stableId: XXXXXXXXXX` → `stableId: sid_XXXXXXXXXX`
 * 2. packages/factbase/data/things/*.yaml — `entity: XXXXXXXXXX` → `entity: sid_XXXXXXXXXX`
 * 3. packages/factbase/data/things/*.yaml — `!ref XXXXXXXXXX` → `!ref sid_XXXXXXXXXX`
 *
 * Uses text-based replacement (NOT YAML parse/serialize) to preserve formatting,
 * comments, and custom tags like `!ref`.
 *
 * Idempotent: skips values already prefixed with `sid_`.
 *
 * Usage:
 *   node --import tsx/esm crux/scripts/migrate-sid-prefix.ts [--dry-run]
 *
 * --dry-run:  Show what would change without writing files
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dirname, "../..");
const DRY_RUN = process.argv.includes("--dry-run");

// ── Patterns ────────────────────────────────────────────────────────

// Match `stableId: <10-char-alphanumeric>` but NOT already prefixed with sid_
const STABLE_ID_RE = /^(\s*stableId:\s+)(?!sid_)([A-Za-z0-9]{10})\s*$/gm;

// Match `entity: <10-char-alphanumeric>` at start of line (factbase files)
// but NOT already prefixed with sid_
const ENTITY_FIELD_RE = /^(entity:\s+)(?!sid_)([A-Za-z0-9]{10})\s*$/gm;

// Match `!ref <10-char-alphanumeric>` but NOT already prefixed with sid_
const REF_TAG_RE = /(!ref\s+)(?!sid_)([A-Za-z0-9]{10})(?=\s|$)/gm;

// Match `- id: <10-char-alphanumeric>` in relatedEntries blocks (entity refs)
// These appear as `    - id: zR4nW8xB2f` with exactly 6 leading spaces
const RELATED_ENTRY_ID_RE = /^(\s+- id:\s+)(?!sid_)([A-Za-z0-9]{10})\s*$/gm;

// ── Stats ───────────────────────────────────────────────────────────

interface Stats {
  filesScanned: number;
  filesModified: number;
  stableIdReplacements: number;
  relatedEntryIdReplacements: number;
  entityFieldReplacements: number;
  refTagReplacements: number;
}

const stats: Stats = {
  filesScanned: 0,
  filesModified: 0,
  stableIdReplacements: 0,
  relatedEntryIdReplacements: 0,
  entityFieldReplacements: 0,
  refTagReplacements: 0,
};

// ── Processing ──────────────────────────────────────────────────────

function processEntityFiles(): void {
  const entitiesDir = join(PROJECT_ROOT, "data/entities");
  const files = readdirSync(entitiesDir).filter((f) => f.endsWith(".yaml"));

  for (const file of files) {
    const filePath = join(entitiesDir, file);
    const original = readFileSync(filePath, "utf-8");
    stats.filesScanned++;

    let stableIdCount = 0;
    let relatedEntryCount = 0;
    let updated = original.replace(STABLE_ID_RE, (_match, prefix, id) => {
      stableIdCount++;
      return `${prefix}sid_${id}`;
    });
    updated = updated.replace(RELATED_ENTRY_ID_RE, (_match, prefix, id) => {
      relatedEntryCount++;
      return `${prefix}sid_${id}`;
    });

    const replacementCount = stableIdCount + relatedEntryCount;
    if (replacementCount > 0) {
      stats.stableIdReplacements += stableIdCount;
      stats.relatedEntryIdReplacements += relatedEntryCount;
      stats.filesModified++;
      if (!DRY_RUN) {
        writeFileSync(filePath, updated, "utf-8");
      }
      const parts: string[] = [];
      if (stableIdCount > 0) parts.push(`${stableIdCount} stableId(s)`);
      if (relatedEntryCount > 0) parts.push(`${relatedEntryCount} relatedEntry id(s)`);
      console.log(
        `  ${DRY_RUN ? "[dry-run] " : ""}data/entities/${file}: ${parts.join(", ")} prefixed`
      );
    }
  }
}

function processFactbaseFiles(): void {
  const thingsDir = join(PROJECT_ROOT, "packages/factbase/data/things");
  const files = readdirSync(thingsDir).filter((f) => f.endsWith(".yaml"));

  for (const file of files) {
    const filePath = join(thingsDir, file);
    const original = readFileSync(filePath, "utf-8");
    stats.filesScanned++;

    let entityCount = 0;
    let refCount = 0;

    let updated = original.replace(ENTITY_FIELD_RE, (_match, prefix, id) => {
      entityCount++;
      return `${prefix}sid_${id}`;
    });

    updated = updated.replace(REF_TAG_RE, (_match, prefix, id) => {
      refCount++;
      return `${prefix}sid_${id}`;
    });

    const totalChanges = entityCount + refCount;
    if (totalChanges > 0) {
      stats.entityFieldReplacements += entityCount;
      stats.refTagReplacements += refCount;
      stats.filesModified++;
      if (!DRY_RUN) {
        writeFileSync(filePath, updated, "utf-8");
      }
      const parts: string[] = [];
      if (entityCount > 0) parts.push(`${entityCount} entity field(s)`);
      if (refCount > 0) parts.push(`${refCount} !ref tag(s)`);
      console.log(
        `  ${DRY_RUN ? "[dry-run] " : ""}packages/factbase/data/things/${file}: ${parts.join(", ")}`
      );
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────

console.log(
  `\n${DRY_RUN ? "=== DRY RUN ===" : "=== Migrating stableIds to sid_ prefix ==="}\n`
);

console.log("Processing data/entities/*.yaml ...");
processEntityFiles();

console.log("\nProcessing packages/factbase/data/things/*.yaml ...");
processFactbaseFiles();

console.log("\n--- Summary ---");
console.log(`Files scanned:            ${stats.filesScanned}`);
console.log(`Files modified:           ${stats.filesModified}`);
console.log(`stableId replacements:    ${stats.stableIdReplacements}`);
console.log(`relatedEntry id replacements: ${stats.relatedEntryIdReplacements}`);
console.log(`entity field replacements: ${stats.entityFieldReplacements}`);
console.log(`!ref tag replacements:    ${stats.refTagReplacements}`);
console.log(
  `Total replacements:       ${stats.stableIdReplacements + stats.relatedEntryIdReplacements + stats.entityFieldReplacements + stats.refTagReplacements}`
);

if (DRY_RUN) {
  console.log("\nNo files were modified (dry run).");
} else {
  console.log("\nDone. All files updated.");
}
