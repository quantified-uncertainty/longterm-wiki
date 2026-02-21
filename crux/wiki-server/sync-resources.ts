/**
 * Wiki Server Resources Sync
 *
 * Reads all data/resources/*.yaml files and bulk-upserts them to the
 * wiki-server's /api/resources/batch endpoint.
 *
 * Reuses the shared batch sync infrastructure from sync-common.ts:
 *   - Pre-sync health check with retries (waits for server to be ready)
 *   - Per-batch retry with exponential backoff (handles transient 5xx errors)
 *   - Fast-fail after N consecutive batch failures
 *
 * Usage:
 *   pnpm crux wiki-server sync-resources
 *   pnpm crux wiki-server sync-resources --dry-run
 *   pnpm crux wiki-server sync-resources --batch-size=100
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
import { getServerUrl, getApiKey } from "../lib/wiki-server-client.ts";
import { waitForHealthy, batchSync } from "./sync-common.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const RESOURCES_DIR = join(PROJECT_ROOT, "data/resources");

// --- Configuration ---
const DEFAULT_BATCH_SIZE = 100;

// --- Types ---

interface YamlResource {
  id: string;
  url: string;
  title?: string;
  type?: string;
  summary?: string;
  review?: string;
  abstract?: string;
  key_points?: string[];
  publication_id?: string;
  authors?: string[];
  published_date?: string | Date;
  tags?: string[];
  local_filename?: string;
  credibility_override?: number;
  fetched_at?: string | Date;
  content_hash?: string;
  cited_by?: string[];
}

export interface SyncResource {
  id: string;
  url: string;
  title: string | null;
  type: string | null;
  summary: string | null;
  review: string | null;
  abstract: string | null;
  keyPoints: string[] | null;
  publicationId: string | null;
  authors: string[] | null;
  publishedDate: string | null;
  tags: string[] | null;
  localFilename: string | null;
  credibilityOverride: number | null;
  fetchedAt: string | null;
  contentHash: string | null;
  citedBy: string[] | null;
}

// --- Helpers ---

function normalizeDate(d: string | Date | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().split("T")[0];
  const dateStr = String(d).split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  return null;
}

function normalizeTimestamp(d: string | Date | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  const str = String(d);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) {
    return str.replace(" ", "T") + "Z";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str + "T00:00:00Z";
  }
  try {
    const parsed = new Date(str);
    if (isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  } catch {
    return null;
  }
}

export function transformResource(r: YamlResource): SyncResource {
  return {
    id: r.id,
    url: r.url,
    title: r.title ?? null,
    type: r.type ?? null,
    summary: r.summary ?? null,
    review: r.review ?? null,
    abstract: r.abstract ?? null,
    keyPoints: r.key_points ?? null,
    publicationId: r.publication_id ?? null,
    authors: r.authors ?? null,
    publishedDate: normalizeDate(r.published_date),
    tags: r.tags ?? null,
    localFilename: r.local_filename ?? null,
    credibilityOverride: r.credibility_override ?? null,
    fetchedAt: normalizeTimestamp(r.fetched_at),
    contentHash: r.content_hash ?? null,
    citedBy: r.cited_by ?? null,
  };
}

/**
 * Read all data/resources/*.yaml files and return parsed resources.
 * Exported for testing.
 */
export function loadResourceYamls(
  dir: string = RESOURCES_DIR
): { resources: YamlResource[]; errorFiles: number } {
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  const resources: YamlResource[] = [];
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

      for (const entry of parsed as YamlResource[]) {
        if (!entry.id || !entry.url) {
          console.warn(`  WARN: ${file} — entry missing id or url, skipping`);
          continue;
        }
        resources.push(entry);
      }
    } catch (err) {
      console.warn(`  ERROR: ${file} — ${err}`);
      errorFiles++;
    }
  }

  return { resources, errorFiles };
}

/**
 * Sync resources to the wiki-server in batches.
 * Exported for testing.
 */
export async function syncResources(
  serverUrl: string,
  items: SyncResource[],
  batchSize: number,
  options: {
    _sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<{ upserted: number; errors: number }> {
  const result = await batchSync(
    `${serverUrl}/api/resources/batch`,
    items,
    batchSize,
    {
      bodyKey: "items",
      responseCountKey: "upserted",
      itemLabel: "resources",
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

  // Load resources
  console.log(`Reading resources from: ${RESOURCES_DIR}`);
  const { resources: yamlResources, errorFiles } = loadResourceYamls();

  if (errorFiles > 0) {
    console.warn(`  ${errorFiles} file(s) had errors`);
  }

  // Transform
  const syncPayloads = yamlResources.map(transformResource);
  const withCitations = syncPayloads.filter(
    (r) => r.citedBy && r.citedBy.length > 0
  );
  const totalCitations = syncPayloads.reduce(
    (sum, r) => sum + (r.citedBy?.length ?? 0),
    0
  );

  console.log(
    `Syncing ${syncPayloads.length} resources to ${serverUrl} (batch size: ${batchSize})`
  );
  console.log(
    `  ${withCitations.length} resources have citations (${totalCitations} total citation links)`
  );

  if (dryRun) {
    console.log("\n[dry-run] Would sync these resources:");
    for (const r of syncPayloads.slice(0, 10)) {
      console.log(`  ${r.id} — ${r.title ?? r.url}`);
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
  const result = await syncResources(serverUrl, syncPayloads, batchSize);

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
