/**
 * Normalize KB fact IDs to opaque `f_` + 10-char alphanumeric format.
 *
 * Facts with IDs that don't match the canonical pattern get new random IDs.
 * The old→new mapping is printed for audit purposes.
 *
 * Usage:
 *   npx tsx packages/kb/scripts/normalize-ids.ts [--dry-run]
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateFactId } from "../src/ids.ts";

const KB_THINGS_DIR = join(import.meta.dirname, "..", "data", "things");

/**
 * Canonical fact ID pattern: f_ followed by exactly 10 alphanumeric chars.
 * Anything else (descriptive IDs like f_rev_2024_12) gets normalized.
 */
const CANONICAL_FACT_ID = /^f_[A-Za-z0-9]{10}$/;

interface IdRename {
  file: string;
  oldId: string;
  newId: string;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const entries = await readdir(KB_THINGS_DIR);
  const yamlFiles = entries.filter((e) => e.endsWith(".yaml"));

  const renames: IdRename[] = [];
  const usedIds = new Set<string>();

  // First pass: collect all existing canonical IDs to avoid collisions
  for (const filename of yamlFiles) {
    const content = await readFile(join(KB_THINGS_DIR, filename), "utf-8");
    const idMatches = content.matchAll(/^\s+-\s+id:\s+(f_\S+)/gm);
    for (const match of idMatches) {
      if (CANONICAL_FACT_ID.test(match[1])) {
        usedIds.add(match[1]);
      }
    }
  }

  // Second pass: rename non-canonical IDs
  for (const filename of yamlFiles) {
    const filepath = join(KB_THINGS_DIR, filename);
    let content = await readFile(filepath, "utf-8");
    let modified = false;

    // Find all fact IDs in this file
    const idMatches = [...content.matchAll(/^(\s+-\s+id:\s+)(f_\S+)/gm)];

    for (const match of idMatches) {
      const oldId = match[2];
      if (CANONICAL_FACT_ID.test(oldId)) continue; // Already canonical

      // Generate a new unique ID
      let newId: string;
      do {
        newId = generateFactId();
      } while (usedIds.has(newId));
      usedIds.add(newId);

      // Replace the ID in the file content (exact match on the line)
      const oldLine = `${match[1]}${oldId}`;
      const newLine = `${match[1]}${newId}`;
      content = content.replace(oldLine, newLine);
      modified = true;

      renames.push({ file: filename, oldId, newId });
    }

    if (modified && !dryRun) {
      await writeFile(filepath, content, "utf-8");
    }
  }

  // Report
  if (renames.length > 0) {
    console.log(`\n${dryRun ? "[DRY RUN] " : ""}Renamed ${renames.length} fact IDs:\n`);
    console.log("File                                     Old ID                        New ID");
    console.log("-".repeat(95));
    for (const r of renames) {
      console.log(
        `${r.file.padEnd(40)} ${r.oldId.padEnd(30)} ${r.newId}`
      );
    }
  } else {
    console.log("\nAll fact IDs are already in canonical format.");
  }

  if (dryRun && renames.length > 0) {
    console.log("\nRe-run without --dry-run to apply changes.");
  }

  // Output mapping as JSON for potential downstream use
  if (renames.length > 0) {
    const mapping: Record<string, string> = {};
    for (const r of renames) {
      mapping[r.oldId] = r.newId;
    }
    const mappingPath = join(KB_THINGS_DIR, "..", ".id-migration-map.json");
    if (!dryRun) {
      await writeFile(mappingPath, JSON.stringify(mapping, null, 2) + "\n", "utf-8");
      console.log(`\nID mapping saved to: ${mappingPath}`);
    }
  }

  console.log(
    `\nSummary: ${renames.length} IDs normalized.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
