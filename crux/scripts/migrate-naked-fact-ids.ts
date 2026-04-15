/**
 * Migrate naked 10-char fact IDs in FactBase YAML to canonical `f_<10>` format.
 *
 * Background: the canonical fact ID format is `f_` + 10 alphanumeric chars
 * (enforced by `normalize-ids.ts` and the `canonical_f` regex in the data-quality
 * dashboard). A prior migration missed naked-10-char IDs that live in flow-style
 * YAML (`{ id: XXX, property: Y }`) and block-style files not matched by the
 * original `normalize-ids.ts` regex (`^\s+-\s+id:\s+(f_\S+)`, which required
 * the `f_` prefix already).
 *
 * This script completes the migration:
 *   1. Loads all fact YAMLs via the FactBase loader and identifies non-canonical IDs.
 *   2. Generates a deterministic `f_<10>` replacement per legacy ID via SHA-256
 *      content hash (stable across reruns — partial runs are resumable).
 *   3. Checks for collisions against existing canonical IDs and against the new
 *      hashes themselves.
 *   4. Rewrites every YAML file containing a legacy ID, replacing only in the
 *      `id:` position (so source URLs etc. cannot be corrupted). A single
 *      alternation regex is compiled once and reused across all files.
 *   5. Writes the old→new mapping to docs/migrations/qua-497-fact-id-mapping.json.
 *
 * Usage:
 *   pnpm tsx crux/scripts/migrate-naked-fact-ids.ts             # dry run
 *   pnpm tsx crux/scripts/migrate-naked-fact-ids.ts --apply     # write changes
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

import { loadKB } from "../../packages/factbase/src/loader.ts";
import { contentHash } from "../../packages/factbase/src/ids.ts";
import type { Graph } from "../../packages/factbase/src/graph.ts";
import { findFiles } from "../lib/file-utils.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const THINGS_DIR = join(PROJECT_ROOT, "packages/factbase/data/things");
const FACTBASE_DATA_DIR = join(PROJECT_ROOT, "packages/factbase/data");
const MAPPING_OUT = join(
  PROJECT_ROOT,
  "docs/migrations/qua-497-fact-id-mapping.json"
);

/** Namespace for content hashing — isolates this run from generateContentFactId's output space. */
const HASH_NAMESPACE = "qua-497";

const CANONICAL_FACT_ID = /^f_[A-Za-z0-9]{10}$/;
const INV_FACT_ID = /^inv_.+$/;

interface FactClassification {
  total: number;
  canonical: number;
  inverse: number;
  legacy: Array<{ factId: string; entityId: string }>;
}

function classifyFacts(graph: Graph): FactClassification {
  const result: FactClassification = { total: 0, canonical: 0, inverse: 0, legacy: [] };
  for (const ent of graph.getAllEntities()) {
    for (const fact of graph.getFacts(ent.id)) {
      result.total++;
      if (CANONICAL_FACT_ID.test(fact.id)) {
        result.canonical++;
      } else if (INV_FACT_ID.test(fact.id)) {
        result.inverse++;
      } else {
        result.legacy.push({ factId: fact.id, entityId: ent.id });
      }
    }
  }
  return result;
}

/**
 * Given legacy IDs, build a stable `legacyId → f_<10>` map. Deterministic
 * across runs. Collides only if SHA-256 truncation collides — a 10-char
 * alphanumeric gives ~50 bits of entropy, so for 776 entries the birthday
 * collision probability is ~1e-10. If a collision ever happens, we abort.
 */
function buildMapping(
  legacyIds: Set<string>,
  reservedCanonical: Set<string>
): { mapping: Map<string, string>; collisions: string[] } {
  const mapping = new Map<string, string>();
  const used = new Set(reservedCanonical);
  const collisions: string[] = [];

  for (const legacyId of [...legacyIds].sort()) {
    const newId = "f_" + contentHash([HASH_NAMESPACE, legacyId]);
    if (used.has(newId)) {
      collisions.push(legacyId);
      continue;
    }
    used.add(newId);
    mapping.set(legacyId, newId);
  }
  return { mapping, collisions };
}

/** Build one alternation regex for all mappings — O(files) rewrite instead of O(files × ids). */
function buildRewriteRegex(mapping: Map<string, string>): RegExp {
  const alternation = [...mapping.keys()].join("|");
  // Anchor to `id: ` key (block / flow / quoted). Trailing `\b` matches at
  // whitespace, quote, comma, or brace. We do NOT match inside string values
  // or URLs by requiring `id:\s+` before the ID.
  return new RegExp(`(\\bid:\\s+['"]?)(${alternation})\\b`, "g");
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  console.log(`${apply ? "APPLYING" : "DRY RUN"} — migrate-naked-fact-ids.ts\n`);

  console.log("Loading FactBase YAML via loader…");
  const { graph } = await loadKB(FACTBASE_DATA_DIR);
  const before = classifyFacts(graph);
  console.log(
    `  ${before.total} facts loaded: ${before.canonical} canonical, ${before.legacy.length} legacy, ${before.inverse} inverse`
  );

  if (before.legacy.length === 0) {
    console.log("\nNothing to migrate — all facts already canonical.");
    return;
  }

  const legacyIds = new Set(before.legacy.map((f) => f.factId));
  const canonicalIds = new Set<string>();
  for (const ent of graph.getAllEntities()) {
    for (const fact of graph.getFacts(ent.id)) {
      if (CANONICAL_FACT_ID.test(fact.id)) canonicalIds.add(fact.id);
    }
  }

  console.log("\nBuilding mapping (SHA-256 content hash)…");
  const { mapping, collisions } = buildMapping(legacyIds, canonicalIds);
  if (collisions.length > 0) {
    console.error(
      `  FATAL: ${collisions.length} legacy IDs hash-collided: ${collisions.slice(0, 5).join(", ")}`
    );
    process.exit(1);
  }
  console.log(`  ${mapping.size} legacy → canonical mappings built`);

  console.log("\nScanning YAML files…");
  const yamlFiles = findFiles(THINGS_DIR, [".yaml", ".yml"]);
  console.log(`  ${yamlFiles.length} YAML files under things/`);

  const rewriteRe = buildRewriteRegex(mapping);
  const changedFiles: Array<{ path: string; count: number }> = [];
  let totalReplacements = 0;

  for (const filepath of yamlFiles) {
    const original = await readFile(filepath, "utf-8");
    let count = 0;
    const updated = original.replace(rewriteRe, (_m, prefix, oldId) => {
      count++;
      return `${prefix}${mapping.get(oldId)}`;
    });
    if (count === 0) continue;
    changedFiles.push({ path: filepath, count });
    totalReplacements += count;
    if (apply) await writeFile(filepath, updated, "utf-8");
  }

  console.log(
    `\n${apply ? "Rewrote" : "Would rewrite"} ${changedFiles.length} files (${totalReplacements} IDs)`
  );
  for (const f of changedFiles.slice(0, 5)) {
    console.log(`  ${f.path.substring(PROJECT_ROOT.length + 1)} (${f.count})`);
  }
  if (changedFiles.length > 5) {
    console.log(`  … +${changedFiles.length - 5} more`);
  }

  const mappingObj: Record<string, string> = {};
  for (const [oldId, newId] of [...mapping].sort((a, b) => a[0].localeCompare(b[0]))) {
    mappingObj[oldId] = newId;
  }
  const mappingJson =
    JSON.stringify(
      {
        ticket: "QUA-497",
        description:
          "Fact ID migration: naked 10-char → canonical f_<10>. Generated by crux/scripts/migrate-naked-fact-ids.ts via SHA-256 content hash namespaced to the migration. Stable across reruns.",
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
    console.log(`\nWould write mapping to ${MAPPING_OUT.substring(PROJECT_ROOT.length + 1)}`);
  }

  if (apply) {
    console.log("\nVerifying post-migration state (re-loading via loader)…");
    const { graph: g2 } = await loadKB(FACTBASE_DATA_DIR);
    const after = classifyFacts(g2);
    console.log(`  canonical after: ${after.canonical}`);
    console.log(`  non-canonical remaining: ${after.legacy.length}`);
    if (after.legacy.length !== 0) {
      console.error("  FAIL: legacy IDs still present after migration:");
      for (const { factId, entityId } of after.legacy.slice(0, 10)) {
        console.error(`    ${factId} on ${entityId}`);
      }
      process.exit(1);
    }
    console.log("  PASS");
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
