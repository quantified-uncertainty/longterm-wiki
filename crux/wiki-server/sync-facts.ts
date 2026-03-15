/**
 * Wiki Server Facts Sync
 *
 * Reads all KB YAML facts from packages/factbase/data/things/ and bulk-upserts
 * them to the wiki-server's /api/facts/sync endpoint.
 *
 * Reuses the shared batch sync infrastructure from sync-common.ts.
 *
 * Usage:
 *   pnpm crux wiki-server sync-facts
 *   pnpm crux wiki-server sync-facts --dry-run
 *   pnpm crux wiki-server sync-facts --batch-size=200
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL   - Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY - Bearer token for authentication
 */

import { join } from "path";
import { fileURLToPath } from "url";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey } from "../lib/wiki-server/client.ts";
import { loadKB } from "../../packages/factbase/src/loader.ts";
import type { Fact, FactValue, Property } from "../../packages/factbase/src/types.ts";
import type { SyncFact } from "../../apps/wiki-server/src/api-types.ts";
import { waitForHealthy, batchSync } from "./sync-common.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const KB_DATA_DIR = join(PROJECT_ROOT, "packages", "factbase", "data");

// --- Configuration ---
const DEFAULT_BATCH_SIZE = 500;

// --- Helpers ---

/**
 * Serialize a FactValue to the string `value` field for the sync API.
 */
function serializeValue(val: FactValue): string | null {
  switch (val.type) {
    case "number":
      return String(val.value);
    case "text":
    case "date":
      return val.value;
    case "boolean":
      return String(val.value);
    case "ref":
      return val.value;
    case "refs":
      return val.value.join(", ");
    case "range":
      return `${val.low}\u2013${val.high}`;
    case "min":
      return `\u2265${val.value}`;
    case "json":
      return JSON.stringify(val.value);
    default:
      return null;
  }
}

/**
 * Extract the numeric value from a FactValue, if applicable.
 */
function extractNumeric(val: FactValue): number | null {
  switch (val.type) {
    case "number":
      return val.value;
    case "min":
      return val.value;
    default:
      return null;
  }
}

/**
 * Extract low/high range values from a FactValue, if applicable.
 */
function extractRange(val: FactValue): { low: number | null; high: number | null } {
  if (val.type === "range") {
    return { low: val.low, high: val.high };
  }
  return { low: null, high: null };
}

/**
 * Transform a KB Fact into a SyncFact payload for the wiki-server API.
 * Optionally accepts the property definition to populate formatDivisor.
 */
export function transformFact(fact: Fact, property?: Property): SyncFact {
  const { low, high } = extractRange(fact.value);

  return {
    entityId: fact.subjectId,
    factId: fact.id,
    label: null,
    value: serializeValue(fact.value),
    numeric: extractNumeric(fact.value),
    low,
    high,
    asOf: fact.asOf ?? null,
    measure: fact.propertyId,
    subject: fact.subjectId,
    note: fact.notes ?? null,
    source: fact.source ?? null,
    format: fact.value.type,
    formatDivisor: property?.display?.divisor ?? null,
  };
}

/**
 * Load all KB facts and transform them into SyncFact payloads.
 * Exported for testing.
 */
export async function loadAndTransformFacts(
  dataDir: string = KB_DATA_DIR,
): Promise<{ facts: SyncFact[]; entityCount: number }> {
  const { graph } = await loadKB(dataDir);
  const allEntities = graph.getAllEntities();
  const syncFacts: SyncFact[] = [];

  for (const entity of allEntities) {
    const facts = graph.getFacts(entity.id);
    for (const fact of facts) {
      // Skip derived/inverse facts — they are computed, not source data
      if (fact.derivedFrom) continue;
      const property = graph.getProperty(fact.propertyId);
      syncFacts.push(transformFact(fact, property));
    }
  }

  return { facts: syncFacts, entityCount: allEntities.length };
}

/**
 * Sync facts to the wiki-server in batches.
 * Exported for testing.
 */
export async function syncFactsBatch(
  serverUrl: string,
  items: SyncFact[],
  batchSize: number,
  options: {
    _sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ upserted: number; errors: number }> {
  const result = await batchSync(
    `${serverUrl}/api/facts/sync`,
    items,
    batchSize,
    {
      bodyKey: "facts",
      responseCountKey: "upserted",
      itemLabel: "facts",
      _sleep: options._sleep,
    },
  );

  return { upserted: result.count, errors: result.errors };
}

// --- CLI ---

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const batchSize = Number(args["batch-size"]) || DEFAULT_BATCH_SIZE;

  const serverUrl = getServerUrl();
  const apiKey = getApiKey();

  if (!serverUrl) {
    console.error(
      "Error: LONGTERMWIKI_SERVER_URL environment variable is required",
    );
    process.exit(1);
  }
  if (!apiKey) {
    console.error(
      "Error: LONGTERMWIKI_SERVER_API_KEY environment variable is required",
    );
    process.exit(1);
  }

  // Load facts
  console.log(`Reading KB facts from: ${KB_DATA_DIR}`);
  const { facts, entityCount } = await loadAndTransformFacts();

  // Group by value type for summary
  const byType = new Map<string, number>();
  for (const f of facts) {
    const t = f.format ?? "unknown";
    byType.set(t, (byType.get(t) || 0) + 1);
  }

  console.log(
    `Loaded ${facts.length} facts from ${entityCount} entities`,
  );
  console.log(
    `  Types: ${[...byType.entries()].map(([t, c]) => `${t}(${c})`).join(", ")}`,
  );

  if (dryRun) {
    console.log("\n[dry-run] Would sync these facts:");
    for (const f of facts.slice(0, 10)) {
      console.log(`  ${f.entityId} / ${f.measure}: ${f.value} (${f.factId})`);
    }
    if (facts.length > 10) {
      console.log(`  ... and ${facts.length - 10} more`);
    }
    process.exit(0);
  }

  console.log(
    `\nSyncing ${facts.length} facts to ${serverUrl} (batch size: ${batchSize})`,
  );

  // Pre-sync health check
  console.log("Checking server health...");
  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) {
    console.error(
      `Error: Server at ${serverUrl} is not healthy after retries. Aborting sync.`,
    );
    process.exit(1);
  }

  // Sync
  const result = await syncFactsBatch(serverUrl, facts, batchSize);

  console.log(`\nSync complete:`);
  console.log(`  Upserted: ${result.upserted}`);
  if (result.errors > 0) {
    console.log(`  Errors:  ${result.errors}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Sync failed:", err);
    process.exit(1);
  });
}
