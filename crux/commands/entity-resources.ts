/**
 * Entity Resources — seed entity-resource relationships from existing data.
 *
 * Two data sources:
 *   1. publisher_entity_id on resources → authoredByEntity=true
 *   2. pageResources in database.json → isSubject=true
 *
 * Usage:
 *   pnpm crux entity-resources seed
 *   pnpm crux entity-resources seed --dry-run
 *   pnpm crux entity-resources seed --source=publisher
 *   pnpm crux entity-resources seed --source=wiki_citation
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { CommandResult } from "../lib/command-types.ts";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import {
  syncEntityResources,
  type EntityResourceSyncItem,
} from "../lib/wiki-server/entity-resources.ts";
import { listResources } from "../lib/wiki-server/resources.ts";

const BATCH_SIZE = 500;

interface SeedOptions {
  "dry-run"?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  source?: string; // 'publisher' | 'wiki_citation' | 'all'
  limit?: string;
}

// ---------------------------------------------------------------------------
// database.json loader (single parse for both slug map and pageResources)
// ---------------------------------------------------------------------------

interface MinimalEntity {
  id: string; // slug
  stableId?: string;
}

interface DatabaseJson {
  typedEntities?: MinimalEntity[];
  pageResources?: Record<string, string[]>;
}

let _cachedDb: DatabaseJson | null = null;

function loadDatabaseJson(): DatabaseJson {
  if (_cachedDb) return _cachedDb;
  const dbPath = join(PROJECT_ROOT, "apps/web/src/data/database.json");
  _cachedDb = JSON.parse(readFileSync(dbPath, "utf8")) as DatabaseJson;
  return _cachedDb;
}

function loadSlugToStableId(): Map<string, string> {
  const db = loadDatabaseJson();
  const entities = db.typedEntities ?? [];
  const map = new Map<string, string>();
  for (const e of entities) {
    if (e.stableId) {
      map.set(e.id, e.stableId);
    }
  }
  return map;
}

function loadPageResources(): Record<string, string[]> {
  return loadDatabaseJson().pageResources ?? {};
}

// ---------------------------------------------------------------------------
// Pass 1: publisher_entity_id → authoredByEntity=true
// ---------------------------------------------------------------------------

async function seedFromPublisher(
  options: SeedOptions,
): Promise<{ items: EntityResourceSyncItem[]; skipped: number }> {
  const items: EntityResourceSyncItem[] = [];
  const maxResources = options.limit ? parseInt(options.limit, 10) : Infinity;
  let offset = 0;
  const pageSize = 500;
  let fetched = 0;
  let skipped = 0;

  while (fetched < maxResources) {
    const result = await listResources(pageSize, offset);
    if (!result.ok) {
      console.error(
        `Failed to fetch resources at offset ${offset}: ${result.message}`,
      );
      break;
    }

    const { resources: batch, total } = result.data;
    if (batch.length === 0) break;

    for (const r of batch) {
      if (fetched >= maxResources) break;
      fetched++;

      const pubEntityId = r.publisherEntityId;
      if (!pubEntityId) continue;

      items.push({
        entityId: pubEntityId,
        resourceId: r.id,
        authoredByEntity: true,
        isSubject: false,
        inferenceSource: "publisher_entity_id",
      });

      if (options.verbose) {
        console.log(
          `  authored: ${pubEntityId} → ${r.id} (${r.title?.slice(0, 60)})`,
        );
      }
    }

    offset += batch.length;
    if (offset >= total) break;
  }

  return { items, skipped };
}

// ---------------------------------------------------------------------------
// Pass 2: pageResources → isSubject=true
// ---------------------------------------------------------------------------

function seedFromWikiCitations(
  options: SeedOptions,
): { items: EntityResourceSyncItem[]; skipped: number } {
  const slugToStableId = loadSlugToStableId();
  const pageResources = loadPageResources();
  const items: EntityResourceSyncItem[] = [];
  let skipped = 0;

  for (const [slug, resourceIds] of Object.entries(pageResources)) {
    const stableId = slugToStableId.get(slug);
    if (!stableId) {
      skipped++;
      if (options.verbose) {
        console.log(`  skip: no entity for page slug "${slug}"`);
      }
      continue;
    }

    for (const resourceId of resourceIds) {
      items.push({
        entityId: stableId,
        resourceId,
        authoredByEntity: false,
        isSubject: true,
        inferenceSource: "wiki_citation",
      });
    }
  }

  return { items, skipped };
}

// ---------------------------------------------------------------------------
// Batch sync
// ---------------------------------------------------------------------------

async function batchSync(
  items: EntityResourceSyncItem[],
  dryRun: boolean,
): Promise<number> {
  if (dryRun || items.length === 0) return 0;

  let synced = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const result = await syncEntityResources(batch);
    if (result.ok) {
      synced += result.data.total;
    } else {
      console.error(
        `  Batch sync failed at offset ${i}: ${result.message}`,
      );
    }
  }
  return synced;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

async function seedCommand(
  _args: string[],
  options: SeedOptions,
): Promise<CommandResult> {
  const dryRun = options["dry-run"] ?? options.dryRun ?? false;
  const source = options.source ?? "all";

  if (dryRun) console.log("DRY RUN — no data will be written\n");

  let totalItems = 0;
  let totalSynced = 0;
  let totalSkipped = 0;

  // Pass 1: publisher_entity_id
  if (source === "all" || source === "publisher") {
    console.log("Pass 1: Seeding from publisher_entity_id...");
    const { items, skipped } = await seedFromPublisher(options);
    console.log(
      `  Found ${items.length} authored-by relationships (${skipped} skipped)`,
    );
    totalItems += items.length;
    totalSkipped += skipped;

    const synced = await batchSync(items, dryRun);
    totalSynced += synced;
    if (!dryRun) console.log(`  Synced ${synced} rows`);
  }

  // Pass 2: pageResources (wiki citations)
  if (source === "all" || source === "wiki_citation") {
    console.log("Pass 2: Seeding from pageResources (wiki citations)...");
    const { items, skipped } = seedFromWikiCitations(options);
    console.log(
      `  Found ${items.length} is-subject relationships (${skipped} page slugs without entities)`,
    );
    totalItems += items.length;
    totalSkipped += skipped;

    const synced = await batchSync(items, dryRun);
    totalSynced += synced;
    if (!dryRun) console.log(`  Synced ${synced} rows`);
  }

  console.log(
    `\nTotal: ${totalItems} items${dryRun ? " (dry run)" : `, ${totalSynced} synced`}, ${totalSkipped} skipped`,
  );

  return { success: true };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands: Record<
  string,
  (args: string[], options: SeedOptions) => Promise<CommandResult>
> = {
  seed: seedCommand,
  default: seedCommand,
};

export function getHelp(): string {
  return `Entity Resources — Seed entity-resource relationships

Commands:
  seed    Populate entity_resources from existing data sources

Options:
  --dry-run     Show what would be written without writing
  --verbose     Print each match
  --source      Restrict to: publisher | wiki_citation | all (default: all)
  --limit       Max resources to process (publisher pass only)

Data sources:
  publisher       Resources with publisher_entity_id → authoredByEntity=true
  wiki_citation   pageResources mapping → isSubject=true
`;
}
