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
const EXPERTS_FILE = join(PROJECT_ROOT, "data/experts.yaml");
const PEOPLE_RESOURCES_FILE = join(PROJECT_ROOT, "data/people-resources.yaml");

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
  // Type-specific fields (stored in metadata JSONB)
  orgType?: string;
  summaryPage?: string;
  developer?: string;
  releaseDate?: string;
  contextWindow?: number;
  inputPrice?: number;
  outputPrice?: number;
  safetyLevel?: string;
  riskCategory?: string;
  [key: string]: unknown; // Allow other type-specific fields
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
  metadata: Record<string, unknown> | null;
}

// --- Expert & People-Resources Types ---

interface ExpertPosition {
  topic: string;
  view: string;
  estimate?: string;
  confidence?: string;
  source?: string;
  date?: string;
}

interface ExpertEntry {
  id: string;
  name: string;
  affiliation?: string;
  role?: string;
  website?: string;
  knownFor?: string[];
  positions?: ExpertPosition[];
}

interface PeopleResourceEntry {
  personId: string;
  personName: string;
  publications?: Array<{
    title: string;
    year?: number;
    type?: string;
    link?: string;
    category?: string;
  }>;
}

// --- Helpers ---

/** Fields that are part of the base entity schema (not metadata). */
const BASE_FIELDS = new Set([
  "id", "numericId", "stableId", "type", "title", "description", "website",
  "tags", "clusters", "status", "lastUpdated", "customFields",
  "relatedEntries", "sources",
]);

/**
 * Extract type-specific fields from the YAML entity into a metadata object.
 * Any field not in BASE_FIELDS is considered type-specific metadata.
 */
function extractMetadata(e: YamlEntity): Record<string, unknown> | null {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(e)) {
    if (!BASE_FIELDS.has(key) && value !== undefined) {
      metadata[key] = value;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

/**
 * Load experts data from data/experts.yaml and return a map keyed by expert id.
 * Returns an empty map if the file doesn't exist or can't be parsed.
 */
export function loadExperts(
  filePath: string = EXPERTS_FILE
): Map<string, ExpertEntry> {
  const map = new Map<string, ExpertEntry>();
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`  WARN: experts.yaml — not an array, skipping`);
      return map;
    }
    for (const entry of parsed as ExpertEntry[]) {
      if (entry.id) {
        map.set(entry.id, entry);
      }
    }
  } catch (err) {
    console.warn(`  WARN: Could not load experts.yaml — ${err}`);
  }
  return map;
}

/**
 * Load people-resources data and return a map of personId → publication count.
 * Returns an empty map if the file doesn't exist or can't be parsed.
 */
export function loadPeopleResources(
  filePath: string = PEOPLE_RESOURCES_FILE
): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = parseYaml(raw);
    if (!Array.isArray(parsed)) {
      console.warn(`  WARN: people-resources.yaml — not an array, skipping`);
      return map;
    }
    for (const entry of parsed as PeopleResourceEntry[]) {
      if (entry.personId) {
        map.set(entry.personId, entry.publications?.length ?? 0);
      }
    }
  } catch (err) {
    console.warn(`  WARN: Could not load people-resources.yaml — ${err}`);
  }
  return map;
}

/**
 * Merge expert data and publication counts into entity metadata.
 * Mutates the entity's metadata in place.
 */
export function mergeExpertData(
  entity: SyncEntity,
  experts: Map<string, ExpertEntry>,
  publicationCounts: Map<string, number>,
): SyncEntity {
  const expert = experts.get(entity.id);
  const pubCount = publicationCounts.get(entity.id);

  if (!expert && pubCount === undefined) {
    return entity;
  }

  const metadata: Record<string, unknown> = { ...(entity.metadata ?? {}) };

  if (expert) {
    if (expert.positions && expert.positions.length > 0) {
      metadata.expertPositions = expert.positions;
    }
    if (expert.knownFor && expert.knownFor.length > 0) {
      metadata.knownFor = expert.knownFor;
    }
    if (expert.affiliation) {
      metadata.affiliation = expert.affiliation;
    }
    if (expert.role) {
      metadata.expertRole = expert.role;
    }
  }

  if (pubCount !== undefined && pubCount > 0) {
    metadata.publicationCount = pubCount;
  }

  entity.metadata = Object.keys(metadata).length > 0 ? metadata : null;
  return entity;
}

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
    metadata: extractMetadata(e),
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
 * Sort entities so that dependencies (referenced entities) come before
 * the entities that reference them. This prevents batch validation failures
 * where a batch references entities that haven't been synced yet.
 *
 * Uses topological sort with cycle-breaking (circular refs are allowed
 * within the same batch since the server validates intra-batch refs).
 */
export function sortByDependencies(entities: SyncEntity[]): SyncEntity[] {
  const idSet = new Set(entities.map((e) => e.id));
  const entityMap = new Map(entities.map((e) => [e.id, e]));

  // Build dependency graph: entity → set of entities it depends on (within sync set)
  const deps = new Map<string, Set<string>>();
  for (const e of entities) {
    const externalDeps = new Set<string>();
    for (const rel of e.relatedEntries ?? []) {
      if (idSet.has(rel.id) && rel.id !== e.id) {
        externalDeps.add(rel.id);
      }
    }
    deps.set(e.id, externalDeps);
  }

  const sorted: SyncEntity[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      // Circular dependency — break cycle, will be handled within same batch
      return;
    }
    visiting.add(id);
    for (const dep of deps.get(id) ?? []) {
      visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
    sorted.push(entityMap.get(id)!);
  }

  for (const e of entities) {
    visit(e.id);
  }

  return sorted;
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

  // Load expert data and publication counts
  console.log(`Loading expert data from: ${EXPERTS_FILE}`);
  const experts = loadExperts();
  console.log(`  Loaded ${experts.size} experts`);

  console.log(`Loading people-resources from: ${PEOPLE_RESOURCES_FILE}`);
  const publicationCounts = loadPeopleResources();
  console.log(`  Loaded publication counts for ${publicationCounts.size} people`);

  // Transform and merge expert data
  const syncPayloads = yamlEntities
    .map(transformEntity)
    .map((e) => mergeExpertData(e, experts, publicationCounts));

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

  // Sort by dependencies so referenced entities are synced before referencing entities
  const sortedPayloads = sortByDependencies(syncPayloads);

  // Sync
  const result = await syncEntities(serverUrl, sortedPayloads, batchSize);

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
