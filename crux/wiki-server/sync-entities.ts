/**
 * Wiki Server Entities Sync
 *
 * Reads all data/entities/*.yaml files and bulk-upserts them to the
 * wiki-server's /api/entities/sync endpoint.
 *
 * Reuses the shared batch sync infrastructure from sync-common.ts.
 *
 * Usage:
 *   pnpm crux wiki-server sync-entities
 *   pnpm crux wiki-server sync-entities --dry-run
 *   pnpm crux wiki-server sync-entities --batch-size=100
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
import { resolveEntityType } from "../lib/hallucination-risk.ts";
import { waitForHealthy, batchSync } from "./sync-common.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const ENTITIES_DIR = join(PROJECT_ROOT, "data/entities");

// --- Configuration ---
const DEFAULT_BATCH_SIZE = 100;

// --- Types ---

interface YamlEntity {
  id: string;
  numericId?: string;
  type: string;
  title: string;
  description?: string;
  website?: string;
  tags?: string[];
  clusters?: string[];
  status?: string;
  lastUpdated?: string;
  customFields?: Array<{ label: string; value: string; link?: string }>;
  relatedEntries?: Array<{ id: string; type: string; relationship?: string }>;
  sources?: Array<{ title: string; url?: string; author?: string; date?: string }>;
}

export interface SyncEntity {
  id: string;
  numericId: string | null;
  entityType: string;
  title: string;
  description: string | null;
  website: string | null;
  tags: string[] | null;
  clusters: string[] | null;
  status: string | null;
  lastUpdated: string | null;
  customFields: Array<{ label: string; value: string; link?: string }> | null;
  relatedEntries: Array<{ id: string; type: string; relationship?: string }> | null;
  sources: Array<{ title: string; url?: string; author?: string; date?: string }> | null;
}

// --- Helpers ---

export function transformEntity(e: YamlEntity): SyncEntity {
  return {
    id: e.id,
    numericId: e.numericId ?? null,
    entityType: resolveEntityType(e.type) ?? e.type,
    title: e.title,
    description: e.description ?? null,
    website: e.website ?? null,
    tags: e.tags ?? null,
    clusters: e.clusters ?? null,
    status: e.status ?? null,
    lastUpdated: e.lastUpdated ?? null,
    customFields: e.customFields ?? null,
    relatedEntries: e.relatedEntries ?? null,
    sources: e.sources ?? null,
  };
}

/**
 * Read all data/entities/*.yaml files and return parsed entities.
 * Exported for testing.
 */
export function loadEntityYamls(
  dir: string = ENTITIES_DIR
): { entities: YamlEntity[]; errorFiles: number } {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  const entities: YamlEntity[] = [];
  let errorFiles = 0;

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = parseYaml(raw);

      if (!Array.isArray(parsed)) {
        console.warn(`  WARN: ${file} — not an array, skipping`);
        errorFiles++;
        continue;
      }

      for (const entry of parsed as YamlEntity[]) {
        if (!entry.id || !entry.type || !entry.title) {
          console.warn(
            `  WARN: ${file} — entry missing id, type, or title (id=${entry.id}), skipping`
          );
          continue;
        }
        entities.push(entry);
      }
    } catch (err) {
      console.warn(`  ERROR: ${file} — ${err}`);
      errorFiles++;
    }
  }

  return { entities, errorFiles };
}

/**
 * Sync entities to the wiki-server in batches.
 * Exported for testing.
 */
export async function syncEntities(
  serverUrl: string,
  items: SyncEntity[],
  batchSize: number,
  options: {
    _sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<{ upserted: number; errors: number }> {
  const result = await batchSync(
    `${serverUrl}/api/entities/sync`,
    items,
    batchSize,
    {
      bodyKey: "entities",
      responseCountKey: "upserted",
      itemLabel: "entities",
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

  // Load entities
  console.log(`Reading entities from: ${ENTITIES_DIR}`);
  const { entities: yamlEntities, errorFiles } = loadEntityYamls();

  if (errorFiles > 0) {
    console.warn(`  ${errorFiles} file(s) had errors`);
  }

  // Transform
  const syncPayloads = yamlEntities.map(transformEntity);

  // Group by type for summary
  const byType = new Map<string, number>();
  for (const e of syncPayloads) {
    byType.set(e.entityType, (byType.get(e.entityType) || 0) + 1);
  }

  console.log(
    `Syncing ${syncPayloads.length} entities to ${serverUrl} (batch size: ${batchSize})`
  );
  console.log(
    `  Types: ${[...byType.entries()].map(([t, c]) => `${t}(${c})`).join(", ")}`
  );

  if (dryRun) {
    console.log("\n[dry-run] Would sync these entities:");
    for (const e of syncPayloads.slice(0, 10)) {
      console.log(`  ${e.id} [${e.entityType}] — ${e.title}`);
    }
    if (syncPayloads.length > 10) {
      console.log(`  ... and ${syncPayloads.length - 10} more`);
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
  const result = await syncEntities(serverUrl, syncPayloads, batchSize);

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
