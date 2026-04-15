/**
 * Migrate naked 10-char fact IDs in FactBase YAML to canonical `f_<10>` format.
 *
 * Background: the canonical fact ID format is `f_` + 10 alphanumeric chars
 * (enforced by `normalize-ids.ts` and the `canonical_f` regex in the data-quality
 * dashboard). A prior migration (QUA-43) missed naked-10-char IDs that live in
 * flow-style YAML (`{ id: XXX, property: Y }`) and block-style files not matched
 * by the original `normalize-ids.ts` regex (`^\s+-\s+id:\s+(f_\S+)`, which
 * required the `f_` prefix already).
 *
 * This script completes the migration for QUA-497:
 *   1. Loads all fact YAMLs via the FactBase loader and identifies non-canonical IDs.
 *   2. Generates a deterministic `f_<10>` replacement per legacy ID via SHA-256
 *      content hash (stable across reruns — partial runs are resumable).
 *   3. Checks for collisions against existing canonical IDs and against the new
 *      hashes themselves.
 *   4. Rewrites every YAML file containing a legacy ID, replacing only in the
 *      `id:` position (so source URLs etc. cannot be corrupted).
 *   5. Writes the old→new mapping to docs/migrations/qua-497-fact-id-mapping.json.
 *
 * Usage:
 *   pnpm tsx crux/scripts/migrate-naked-fact-ids.ts             # dry run
 *   pnpm tsx crux/scripts/migrate-naked-fact-ids.ts --apply     # write changes
 *
 * References:
 *   - Linear: QUA-497 (this ticket), QUA-43 (prior partial migration)
 *   - .claude/rules/id-system.md
 *   - packages/factbase/scripts/normalize-ids.ts (predecessor)
 */

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { createHash } from "node:crypto";

import { loadKB } from "../../packages/factbase/src/loader.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const THINGS_DIR = join(PROJECT_ROOT, "packages/factbase/data/things");
const FACTBASE_DATA_DIR = join(PROJECT_ROOT, "packages/factbase/data");
const MAPPING_OUT = join(
  PROJECT_ROOT,
  "docs/migrations/qua-497-fact-id-mapping.json"
);

const CANONICAL_FACT_ID = /^f_[A-Za-z0-9]{10}$/;
const INV_FACT_ID = /^inv_.+$/;

/** 10-char base64url SHA-256 hash, normalized to alphanumeric (no `-`/`_`). */
function contentHash10(input: string): string {
  const raw = createHash("sha256")
    .update(input, "utf8")
    .digest("base64url")
    .slice(0, 10);
  // Normalize to alphanumeric — replace any `-`/`_` deterministically.
  return raw.replace(/[-_]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
    return alphabet[code % alphabet.length];
  });
}

async function walkYaml(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkYaml(full)));
    } else if (
      entry.isFile() &&
      (extname(entry.name) === ".yaml" || extname(entry.name) === ".yml")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Given a set of legacy IDs and a desired prefix, build a stable map
 * `legacy → f_<10>`. Deterministic across runs. Collides only if SHA-256
 * truncation collides (birthday paradox: ~2^30 entries).
 */
function buildMapping(
  legacyIds: Set<string>,
  reservedCanonical: Set<string>
): { mapping: Map<string, string>; collisions: string[] } {
  const mapping = new Map<string, string>();
  const used = new Set(reservedCanonical);
  const collisions: string[] = [];

  // Sort for determinism across runs.
  const sorted = [...legacyIds].sort();
  for (const legacyId of sorted) {
    // Seed includes a migration-specific namespace to ensure we don't ever
    // collide with the historical hashes used by generateContentFactId().
    let salt = 0;
    let newId = "f_" + contentHash10(`qua-497:${legacyId}`);
    while (used.has(newId)) {
      salt++;
      if (salt > 100) {
        collisions.push(legacyId);
        break;
      }
      newId = "f_" + contentHash10(`qua-497:${legacyId}:${salt}`);
    }
    if (salt <= 100) {
      used.add(newId);
      mapping.set(legacyId, newId);
    }
  }
  return { mapping, collisions };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;

  console.log(
    `${dryRun ? "DRY RUN" : "APPLYING"} — migrate-naked-fact-ids.ts (QUA-497)`
  );
  console.log();

  // 1. Load KB and identify legacy IDs.
  console.log("Loading FactBase YAML via loader…");
  const { graph } = await loadKB(FACTBASE_DATA_DIR);
  const entities = graph.getAllEntities();

  const legacyIds = new Set<string>();
  const canonicalIds = new Set<string>();
  let totalFacts = 0;
  for (const ent of entities) {
    for (const fact of graph.getFacts(ent.id)) {
      totalFacts++;
      if (CANONICAL_FACT_ID.test(fact.id)) {
        canonicalIds.add(fact.id);
      } else if (INV_FACT_ID.test(fact.id)) {
        // computed inverses — skip
      } else {
        legacyIds.add(fact.id);
      }
    }
  }
  console.log(
    `  ${totalFacts} facts loaded: ${canonicalIds.size} canonical, ${legacyIds.size} legacy`
  );

  if (legacyIds.size === 0) {
    console.log("\nNothing to migrate — all facts already canonical.");
    return;
  }

  // 2. Build stable mapping.
  console.log("\nBuilding mapping (SHA-256 content hash)…");
  const { mapping, collisions } = buildMapping(legacyIds, canonicalIds);
  if (collisions.length > 0) {
    console.error(
      `  FATAL: ${collisions.length} legacy IDs failed to map (hash collision): ${collisions.slice(0, 5).join(", ")}`
    );
    process.exit(1);
  }
  console.log(`  ${mapping.size} legacy → canonical mappings built`);

  // 3. Walk the tree, rewrite in-place.
  console.log("\nScanning YAML files…");
  const yamlFiles = await walkYaml(THINGS_DIR);
  console.log(`  ${yamlFiles.length} YAML files under things/`);

  const changedFiles: Array<{
    path: string;
    replacements: Array<{ oldId: string; newId: string }>;
  }> = [];
  let totalReplacements = 0;

  // For speed: build one regex per legacy ID that appears in each file.
  for (const filepath of yamlFiles) {
    let content = await readFile(filepath, "utf-8");
    const replacements: Array<{ oldId: string; newId: string }> = [];

    for (const [oldId, newId] of mapping) {
      // Only match when the ID follows an `id:` key (handles both block
      // `- id: XXX` and flow `{ id: XXX, ... }` styles). Whitespace-tolerant.
      // We intentionally do NOT match inside string values or URLs by
      // anchoring to `id:\s+`.
      const re = new RegExp(`(\\bid:\\s+)${oldId}\\b`, "g");
      let matchCount = 0;
      content = content.replace(re, (_match, prefix) => {
        matchCount++;
        return `${prefix}${newId}`;
      });
      if (matchCount > 0) {
        replacements.push({ oldId, newId });
        totalReplacements += matchCount;
      }
    }

    if (replacements.length > 0) {
      changedFiles.push({ path: filepath, replacements });
      if (apply) {
        await writeFile(filepath, content, "utf-8");
      }
    }
  }

  console.log(
    `\n${apply ? "Rewrote" : "Would rewrite"} ${changedFiles.length} files (${totalReplacements} IDs)`
  );
  if (changedFiles.length <= 10) {
    for (const f of changedFiles) {
      const rel = f.path.substring(PROJECT_ROOT.length + 1);
      console.log(`  ${rel} (${f.replacements.length})`);
    }
  } else {
    for (const f of changedFiles.slice(0, 5)) {
      const rel = f.path.substring(PROJECT_ROOT.length + 1);
      console.log(`  ${rel} (${f.replacements.length})`);
    }
    console.log(`  … +${changedFiles.length - 5} more`);
  }

  // 4. Write mapping artifact.
  const mappingObj: Record<string, string> = {};
  for (const [oldId, newId] of [...mapping].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    mappingObj[oldId] = newId;
  }
  const mappingJson = JSON.stringify(
    {
      ticket: "QUA-497",
      description:
        "Fact ID migration: naked 10-char → canonical f_<10>. Generated by crux/scripts/migrate-naked-fact-ids.ts using SHA-256 content hash of the legacy ID (salted 'qua-497:'). Stable across reruns.",
      generatedAt: new Date().toISOString(),
      totalLegacyIds: mapping.size,
      mapping: mappingObj,
    },
    null,
    2
  ) + "\n";

  if (apply) {
    await mkdir(dirname(MAPPING_OUT), { recursive: true });
    await writeFile(MAPPING_OUT, mappingJson, "utf-8");
    console.log(`\nWrote mapping to ${MAPPING_OUT.substring(PROJECT_ROOT.length + 1)}`);
  } else {
    console.log(
      `\nWould write mapping to ${MAPPING_OUT.substring(PROJECT_ROOT.length + 1)}`
    );
  }

  // 5. Verification pass (only when applying — re-load and check).
  if (apply) {
    console.log("\nVerifying post-migration state…");
    const { graph: g2 } = await loadKB(FACTBASE_DATA_DIR);
    const entities2 = g2.getAllEntities();
    let remaining = 0;
    let canonicalAfter = 0;
    for (const ent of entities2) {
      for (const fact of g2.getFacts(ent.id)) {
        if (CANONICAL_FACT_ID.test(fact.id)) canonicalAfter++;
        else if (!INV_FACT_ID.test(fact.id)) remaining++;
      }
    }
    console.log(`  canonical after: ${canonicalAfter}`);
    console.log(`  non-canonical remaining: ${remaining}`);
    if (remaining !== 0) {
      console.error("  FAIL: legacy IDs still present after migration");
      process.exit(1);
    }
    console.log("  PASS");
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
