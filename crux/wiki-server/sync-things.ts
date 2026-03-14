/**
 * Wiki Server Things Sync
 *
 * Reconciles the unified `things` table by reading data from all domain
 * sync endpoints and upserting via /api/things/sync.
 *
 * In practice, the things table is populated by migration 0087 and
 * kept up-to-date by domain sync endpoints that dual-write to things.
 * This script is a reconciliation tool: run it to fill gaps, fix drift,
 * or after adding a new domain table.
 *
 * Usage:
 *   pnpm crux wiki-server sync-things
 *   pnpm crux wiki-server sync-things --dry-run
 *   pnpm crux wiki-server sync-things --type=entity
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL   - Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY - Bearer token for authentication
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, buildHeaders } from "../lib/wiki-server/client.ts";
import { waitForHealthy, fetchWithRetry } from "./sync-common.ts";
import { OLD_TYPE_MAP } from "../../apps/web/src/data/entity-type-names.ts";

/** Remap raw YAML entity type to canonical type (e.g. "lab" → "organization") */
function resolveEntityType(rawType: string): string {
  return OLD_TYPE_MAP[rawType] ?? rawType;
}

const SUPPORTED_TYPES = ["entity", "resource"] as const;
type SupportedType = (typeof SUPPORTED_TYPES)[number];

const PROJECT_ROOT = join(import.meta.dirname!, "../..");

// ---- Types ----

interface ThingRecord {
  id: string;
  thingType: string;
  title: string;
  parentThingId?: string;
  sourceTable: string;
  sourceId: string;
  entityType?: string;
  description?: string;
  sourceUrl?: string;
  numericId?: string;
}

// ---- Data loaders ----

function loadEntities(): ThingRecord[] {
  const dir = join(PROJECT_ROOT, "data/entities");
  const records: ThingRecord[] = [];

  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".yaml")) continue;
    const content = readFileSync(join(dir, file), "utf-8");
    const entries = parseYaml(content) as Array<{
      id: string;
      numericId?: string;
      stableId?: string;
      type: string;
      title: string;
      description?: string;
      website?: string;
    }>;

    if (!Array.isArray(entries)) continue;

    for (const e of entries) {
      records.push({
        id: e.stableId || e.id,
        thingType: "entity",
        title: e.title,
        sourceTable: "entities",
        sourceId: e.id,
        entityType: resolveEntityType(e.type),
        description: e.description,
        sourceUrl: e.website,
        numericId: e.numericId,
      });
    }
  }

  return records;
}

function loadResources(): ThingRecord[] {
  const dir = join(PROJECT_ROOT, "data/resources");
  const records: ThingRecord[] = [];

  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".yaml")) continue;
    const content = readFileSync(join(dir, file), "utf-8");
    const entries = parseYaml(content);

    if (!Array.isArray(entries)) continue;

    for (const r of entries) {
      if (!r.id || !r.url) continue;
      records.push({
        id: r.stableId || r.id,
        thingType: "resource",
        title: r.title || r.url,
        sourceTable: "resources",
        sourceId: r.id,
        description: r.summary || r.abstract,
        sourceUrl: r.url,
      });
    }
  }

  return records;
}

// ---- Main ----

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    flags: ["dry-run", "help"],
    options: ["type"],
  });

  if (args.flags.has("help")) {
    console.log(`Usage: pnpm crux wiki-server sync-things [--dry-run] [--type=entity|resource|...]`);
    process.exit(0);
  }

  const dryRun = args.flags.has("dry-run");
  const filterType = args.options.get("type") as SupportedType | undefined;

  if (filterType && !SUPPORTED_TYPES.includes(filterType as SupportedType)) {
    console.error(
      `Unknown --type="${filterType}". Supported: ${SUPPORTED_TYPES.join(", ")}`
    );
    process.exit(1);
  }

  console.log("Loading things from YAML data...\n");

  const allRecords: ThingRecord[] = [];

  if (!filterType || filterType === "entity") {
    const entities = loadEntities();
    console.log(`  Entities: ${entities.length}`);
    allRecords.push(...entities);
  }

  if (!filterType || filterType === "resource") {
    const resources = loadResources();
    console.log(`  Resources: ${resources.length}`);
    allRecords.push(...resources);
  }

  // Note: structured records (grants, personnel, divisions, etc.) are
  // populated from the DB by the migration, not from YAML files directly.
  // This sync script focuses on entity and resource types that come from YAML.

  console.log(`\nTotal: ${allRecords.length} things to sync`);

  if (dryRun) {
    console.log("\nDry run — no changes made.");

    // Show summary by type
    const byType: Record<string, number> = {};
    for (const r of allRecords) {
      byType[r.thingType] = (byType[r.thingType] || 0) + 1;
    }
    console.log("\nBy type:");
    for (const [type, count] of Object.entries(byType).sort(([, a], [, b]) => b - a)) {
      console.log(`  ${type}: ${count}`);
    }
    return;
  }

  const serverUrl = getServerUrl();
  console.log(`\nSyncing to ${serverUrl}/api/things/sync ...`);

  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) {
    console.error("Server not healthy — aborting.");
    process.exit(1);
  }

  // Sync in batches
  const BATCH_SIZE = 100;
  let synced = 0;
  let errors = 0;

  for (let i = 0; i < allRecords.length; i += BATCH_SIZE) {
    const batch = allRecords.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allRecords.length / BATCH_SIZE);

    try {
      const res = await fetchWithRetry(
        `${serverUrl}/api/things/sync`,
        {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify({ things: batch }),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        console.error(`  Batch ${batchNum}/${totalBatches}: HTTP ${res.status} — ${body.slice(0, 200)}`);
        errors += batch.length;
      } else {
        const result = await res.json() as { upserted: number };
        synced += result.upserted;
        console.log(`  Batch ${batchNum}/${totalBatches}: ${result.upserted} upserted`);
      }
    } catch (err) {
      console.error(`  Batch ${batchNum}/${totalBatches}: ${err}`);
      errors += batch.length;
    }
  }

  console.log(`\nDone: ${synced} synced, ${errors} errors`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
