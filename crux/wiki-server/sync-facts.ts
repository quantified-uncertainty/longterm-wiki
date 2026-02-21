/**
 * Wiki Server Facts Sync
 *
 * Reads all data/facts/*.yaml files and bulk-upserts them to the
 * wiki-server's /api/facts/sync endpoint.
 *
 * YAML stays authoritative — the DB is a read mirror for querying.
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

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey } from "../lib/wiki-server/client.ts";
import { waitForHealthy, batchSync } from "./sync-common.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const FACTS_DIR = join(PROJECT_ROOT, "data/facts");

// --- Configuration ---
const DEFAULT_BATCH_SIZE = 200;

// --- Types ---

interface YamlFactValue {
  min?: number;
  max?: number;
}

interface YamlFact {
  label?: string;
  value?: number | string | number[] | YamlFactValue;
  asOf?: string;
  note?: string;
  source?: string;
  sourceResource?: string;
  measure?: string;
  subject?: string;
  compute?: string;
  format?: string;
  formatDivisor?: number;
}

interface YamlFactsFile {
  entity: string;
  facts: Record<string, YamlFact>;
}

export interface SyncFact {
  entityId: string;
  factId: string;
  label: string | null;
  value: string | null;
  numeric: number | null;
  low: number | null;
  high: number | null;
  asOf: string | null;
  measure: string | null;
  subject: string | null;
  note: string | null;
  source: string | null;
  sourceResource: string | null;
  format: string | null;
  formatDivisor: number | null;
}

// --- Helpers ---

/**
 * Parse a fact value into its components: string representation, numeric,
 * low/high range bounds.
 */
function parseFactValue(
  val: YamlFact["value"]
): { value: string | null; numeric: number | null; low: number | null; high: number | null } {
  if (val === undefined || val === null) {
    return { value: null, numeric: null, low: null, high: null };
  }

  if (typeof val === "number") {
    return { value: String(val), numeric: val, low: null, high: null };
  }

  if (typeof val === "string") {
    const num = Number(val);
    return {
      value: val,
      numeric: isNaN(num) ? null : num,
      low: null,
      high: null,
    };
  }

  // Array [low, high]
  if (Array.isArray(val) && val.length >= 2) {
    const low = val[0];
    const high = val[1];
    return {
      value: `${low}-${high}`,
      numeric: null,
      low,
      high,
    };
  }

  // Object with min/max
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    const obj = val as YamlFactValue;
    if (obj.min !== undefined && obj.max !== undefined) {
      return {
        value: `${obj.min}-${obj.max}`,
        numeric: null,
        low: obj.min,
        high: obj.max,
      };
    }
  }

  return { value: String(val), numeric: null, low: null, high: null };
}

export function transformFact(entityId: string, factId: string, f: YamlFact): SyncFact {
  const { value, numeric, low, high } = parseFactValue(f.value);

  return {
    entityId,
    factId,
    label: f.label ?? null,
    value,
    numeric,
    low,
    high,
    asOf: f.asOf ? String(f.asOf) : null,
    measure: f.measure ?? null,
    subject: f.subject ?? null,
    note: f.note ?? null,
    source: f.source ?? null,
    sourceResource: f.sourceResource ? String(f.sourceResource) : null,
    format: f.format ?? null,
    formatDivisor: f.formatDivisor ?? null,
  };
}

/**
 * Read all data/facts/*.yaml files and return parsed facts.
 * Exported for testing.
 */
export function loadFactYamls(
  dir: string = FACTS_DIR
): { facts: SyncFact[]; errorFiles: number } {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  const allFacts: SyncFact[] = [];
  let errorFiles = 0;

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = parseYaml(raw) as YamlFactsFile;

      if (!parsed.entity || !parsed.facts) {
        console.warn(`  WARN: ${file} — missing entity or facts field, skipping`);
        errorFiles++;
        continue;
      }

      const entityId = parsed.entity;
      for (const [factId, factData] of Object.entries(parsed.facts)) {
        allFacts.push(transformFact(entityId, factId, factData));
      }
    } catch (err) {
      console.warn(`  ERROR: ${file} — ${err}`);
      errorFiles++;
    }
  }

  return { facts: allFacts, errorFiles };
}

/**
 * Sync facts to the wiki-server in batches.
 * Exported for testing.
 */
export async function syncFacts(
  serverUrl: string,
  items: SyncFact[],
  batchSize: number,
  options: {
    _sleep?: (ms: number) => Promise<void>;
  } = {}
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
      "Error: LONGTERMWIKI_SERVER_URL environment variable is required"
    );
    process.exit(1);
  }
  if (!apiKey) {
    console.error(
      "Error: LONGTERMWIKI_SERVER_API_KEY environment variable is required"
    );
    process.exit(1);
  }

  // Load facts
  console.log(`Reading facts from: ${FACTS_DIR}`);
  const { facts: allFacts, errorFiles } = loadFactYamls();

  if (errorFiles > 0) {
    console.warn(`  ${errorFiles} file(s) had errors`);
  }

  // Group by entity for summary
  const byEntity = new Map<string, number>();
  for (const f of allFacts) {
    byEntity.set(f.entityId, (byEntity.get(f.entityId) || 0) + 1);
  }

  // Count measures
  const measures = new Set(allFacts.filter((f) => f.measure).map((f) => f.measure));

  console.log(
    `Syncing ${allFacts.length} facts from ${byEntity.size} entities to ${serverUrl} (batch size: ${batchSize})`
  );
  console.log(
    `  ${measures.size} unique measures, ${allFacts.filter((f) => f.asOf).length} with timestamps`
  );

  if (dryRun) {
    console.log("\n[dry-run] Would sync facts for these entities:");
    for (const [entityId, count] of [...byEntity.entries()].slice(0, 10)) {
      console.log(`  ${entityId}: ${count} facts`);
    }
    if (byEntity.size > 10) {
      console.log(`  ... and ${byEntity.size - 10} more entities`);
    }
    process.exit(0);
  }

  // Pre-sync health check
  console.log("\nChecking server health...");
  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) {
    console.error(
      `Error: Server at ${serverUrl} is not healthy after retries. Aborting sync.`
    );
    process.exit(1);
  }

  // Sync
  const result = await syncFacts(serverUrl, allFacts, batchSize);

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
