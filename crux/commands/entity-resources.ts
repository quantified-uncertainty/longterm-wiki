/**
 * Entity Resources — seed entity-resource relationships from existing data.
 *
 * Three data sources:
 *   1. publisher_entity_id on resources → authoredByEntity=true
 *   2. pageResources in database.json → isSubject=true
 *   3. literature.yaml org+link → authoredByEntity=true
 *
 * Usage:
 *   pnpm crux entity-resources seed
 *   pnpm crux entity-resources seed --dry-run
 *   pnpm crux entity-resources seed --source=publisher
 *   pnpm crux entity-resources seed --source=wiki_citation
 *   pnpm crux entity-resources seed --source=literature
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { normalizeUrlForDedup } from "@longterm-wiki/url-utils";
import type { CommandResult } from "../lib/command-types.ts";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import {
  syncEntityResources,
  type EntityResourceSyncItem,
} from "../lib/wiki-server/entity-resources.ts";
import { listResources } from "../lib/wiki-server/resources.ts";

const BATCH_SIZE = 500;
const LIST_PAGE_SIZE = 500;

type SeedSource = "publisher" | "wiki_citation" | "literature" | "author" | "all";

interface SeedOptions {
  "dry-run"?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  source?: SeedSource;
  limit?: string;
}

// ---------------------------------------------------------------------------
// database.json loader (single parse for both slug map and pageResources)
// ---------------------------------------------------------------------------

interface MinimalEntity {
  id: string; // slug
  stableId?: string;
  title?: string;
  aliases?: string[];
  entityType?: string;
}

interface DatabaseJson {
  typedEntities?: MinimalEntity[];
  pageResources?: Record<string, string[]>;
}

// entity_resources.resource_id references resources.stable_id (not the
// legacy hex16 resources.id) — all seed passes below emit stable_ids.
interface MinimalResource {
  id: string;
  url?: string;
  stable_id?: string;
}

// ---------------------------------------------------------------------------
// literature.yaml types
// ---------------------------------------------------------------------------

interface LiteraturePaper {
  title: string;
  authors?: string[];
  organization?: string;
  year?: number;
  type?: string;
  link?: string;
}

interface LiteratureCategory {
  id: string;
  name: string;
  papers: LiteraturePaper[];
}

interface LiteratureYaml {
  categories: LiteratureCategory[];
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
// Resource URL index (from resources.json)
// ---------------------------------------------------------------------------

let _cachedResources: MinimalResource[] | null = null;

function loadResources(): MinimalResource[] {
  if (_cachedResources) return _cachedResources;
  const resPath = join(PROJECT_ROOT, "apps/web/src/data/resources.json");
  _cachedResources = JSON.parse(readFileSync(resPath, "utf8")) as MinimalResource[];
  return _cachedResources;
}


/** Normalized-URL → resource stable_id map from resources.json. */
function buildUrlToResourceId(): Map<string, string> {
  const resources = loadResources();
  const map = new Map<string, string>();
  for (const r of resources) {
    if (r.url && r.stable_id) {
      map.set(normalizeUrlForDedup(r.url), r.stable_id);
    }
  }
  return map;
}

/** Legacy hex16 → stable_id map, for translating pageResources entries. */
function buildHexIdToStableId(): Map<string, string> {
  const resources = loadResources();
  const map = new Map<string, string>();
  for (const r of resources) {
    if (r.stable_id) {
      map.set(r.id, r.stable_id);
    }
  }
  return map;
}

/**
 * Build org name → stableId map for fuzzy matching of literature.yaml
 * organization names. Indexes by lowercase slug, title, and aliases.
 */
function buildOrgNameToStableId(): Map<string, string> {
  const db = loadDatabaseJson();
  const entities = db.typedEntities ?? [];
  const map = new Map<string, string>();
  for (const e of entities) {
    if (e.entityType !== "organization" || !e.stableId) continue;

    // Index by slug (id)
    map.set(e.id.toLowerCase(), e.stableId);

    // Index by title
    if (e.title) {
      map.set(e.title.toLowerCase(), e.stableId);
    }

    // Index by each alias
    if (e.aliases) {
      for (const alias of e.aliases) {
        map.set(alias.toLowerCase(), e.stableId);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Pass 1: publisher_entity_id → authoredByEntity=true
// ---------------------------------------------------------------------------

async function seedFromPublisher(
  options: SeedOptions,
): Promise<{ items: EntityResourceSyncItem[]; resourcesFetched: number }> {
  const items: EntityResourceSyncItem[] = [];
  const maxResources = options.limit ? parseInt(options.limit, 10) : Infinity;
  let offset = 0;
  let fetched = 0;

  while (fetched < maxResources) {
    const result = await listResources(LIST_PAGE_SIZE, offset);
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

      if (!r.stableId) continue;

      items.push({
        entityId: pubEntityId,
        resourceId: r.stableId,
        authoredByEntity: true,
        isSubject: false,
        inferenceSource: "publisher_entity_id",
      });

      if (options.verbose) {
        console.log(
          `  authored: ${pubEntityId} → ${r.stableId} (${r.title?.slice(0, 60)})`,
        );
      }
    }

    offset += batch.length;
    if (offset >= total) break;
  }

  return { items, resourcesFetched: fetched };
}

// ---------------------------------------------------------------------------
// Pass 2: pageResources → isSubject=true
// ---------------------------------------------------------------------------

function seedFromWikiCitations(
  options: SeedOptions,
): { items: EntityResourceSyncItem[]; skipped: number } {
  const slugToStableId = loadSlugToStableId();
  const pageResources = loadPageResources();
  const hexToStableId = buildHexIdToStableId();
  const knownStableIds = new Set(hexToStableId.values());
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
      // pageResources may contain either hex16 (legacy build-data.mjs
      // output) or sid_-prefixed IDs, depending on when it was built.
      // For sid_ values, validate against knownStableIds to catch stale
      // or invalid IDs that no longer exist in the resources table.
      const translated = resourceId.startsWith("sid_")
        ? knownStableIds.has(resourceId)
          ? resourceId
          : undefined
        : hexToStableId.get(resourceId);
      if (!translated) {
        skipped++;
        if (options.verbose) {
          console.log(
            `  skip: no stable_id for resource "${resourceId}" on page "${slug}"`,
          );
        }
        continue;
      }
      items.push({
        entityId: stableId,
        resourceId: translated,
        authoredByEntity: false,
        isSubject: true,
        inferenceSource: "wiki_citation",
      });
    }
  }

  return { items, skipped };
}

// ---------------------------------------------------------------------------
// Pass 3: literature.yaml → authoredByEntity=true
// ---------------------------------------------------------------------------

function seedFromLiterature(
  options: SeedOptions,
): { items: EntityResourceSyncItem[]; skippedNoOrg: number; skippedNoLink: number; skippedOrgNotFound: number; skippedUrlNotFound: number } {
  const litPath = join(PROJECT_ROOT, "data/literature.yaml");
  const litData = parseYaml(readFileSync(litPath, "utf8")) as LiteratureYaml;

  const orgNameMap = buildOrgNameToStableId();
  const urlToResourceId = buildUrlToResourceId();
  const items: EntityResourceSyncItem[] = [];

  let skippedNoOrg = 0;
  let skippedNoLink = 0;
  let skippedOrgNotFound = 0;
  let skippedUrlNotFound = 0;

  for (const category of litData.categories) {
    for (const paper of category.papers) {
      // Skip papers without organization
      if (!paper.organization) {
        skippedNoOrg++;
        continue;
      }

      // Skip papers without link
      if (!paper.link) {
        skippedNoLink++;
        if (options.verbose) {
          console.log(`  skip: no link for "${paper.title}"`);
        }
        continue;
      }

      // Resolve organization name to entity stableId
      const orgStableId = orgNameMap.get(paper.organization.toLowerCase());
      if (!orgStableId) {
        skippedOrgNotFound++;
        if (options.verbose) {
          console.log(`  skip: org not found "${paper.organization}" for "${paper.title}"`);
        }
        continue;
      }

      // Resolve link URL to resource ID
      const normalizedUrl = normalizeUrlForDedup(paper.link);
      const resourceId = urlToResourceId.get(normalizedUrl);
      if (!resourceId) {
        skippedUrlNotFound++;
        if (options.verbose) {
          console.log(`  skip: resource not found for URL "${paper.link}" ("${paper.title}")`);
        }
        continue;
      }

      items.push({
        entityId: orgStableId,
        resourceId,
        authoredByEntity: true,
        isSubject: false,
        inferenceSource: "literature_yaml",
      });

      if (options.verbose) {
        console.log(
          `  authored: ${orgStableId} (${paper.organization}) → ${resourceId} (${paper.title.slice(0, 60)})`,
        );
      }
    }
  }

  return { items, skippedNoOrg, skippedNoLink, skippedOrgNotFound, skippedUrlNotFound };
}

// ---------------------------------------------------------------------------
// Pass 4: author_entity_ids → authoredByEntity=true (person → resource)
// ---------------------------------------------------------------------------

async function seedFromAuthorEntityIds(
  options: SeedOptions,
): Promise<{ items: EntityResourceSyncItem[]; resourcesFetched: number }> {
  const items: EntityResourceSyncItem[] = [];
  const maxResources = options.limit ? parseInt(options.limit, 10) : Infinity;
  let offset = 0;
  let fetched = 0;

  while (fetched < maxResources) {
    const result = await listResources(LIST_PAGE_SIZE, offset);
    if (!result.ok) {
      console.error(`Failed to fetch resources at offset ${offset}: ${result.message}`);
      break;
    }

    const { resources: batch, total } = result.data;
    if (batch.length === 0) break;

    for (const r of batch) {
      if (fetched >= maxResources) break;
      fetched++;

      const rawAuthorIds = (r as Record<string, unknown>).authorEntityIds;
      if (!Array.isArray(rawAuthorIds) || rawAuthorIds.length === 0) continue;
      if (!r.stableId) continue;

      // Filter to strings only and deduplicate per resource
      const seen = new Set<string>();
      for (const raw of rawAuthorIds) {
        if (typeof raw !== "string" || !raw) continue;
        if (seen.has(raw)) continue;
        seen.add(raw);

        items.push({
          entityId: raw,
          resourceId: r.stableId,
          authoredByEntity: true,
          isSubject: false,
          inferenceSource: "author_entity_ids",
        });

        if (options.verbose) {
          console.log(`  authored: ${raw} → ${r.stableId} (${r.title?.slice(0, 60)})`);
        }
      }
    }

    offset += batch.length;
    if (offset >= total) break;
  }

  return { items, resourcesFetched: fetched };
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
      synced += result.data.upserted;
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
  // Track resources fetched across limit-aware passes (publisher + author) for global --limit enforcement
  let totalResourcesFetched = 0;

  // Pass 1: publisher_entity_id
  if (source === "all" || source === "publisher") {
    console.log("Pass 1: Seeding from publisher_entity_id...");
    const { items, resourcesFetched } = await seedFromPublisher(options);
    console.log(`  Found ${items.length} authored-by relationships`);
    totalItems += items.length;
    totalResourcesFetched += resourcesFetched;

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

  // Pass 3: literature.yaml (org → resource authored-by)
  if (source === "all" || source === "literature") {
    console.log("Pass 3: Seeding from literature.yaml...");
    const { items, skippedNoOrg, skippedNoLink, skippedOrgNotFound, skippedUrlNotFound } =
      seedFromLiterature(options);
    const totalLitSkipped = skippedNoOrg + skippedNoLink + skippedOrgNotFound + skippedUrlNotFound;
    console.log(
      `  Found ${items.length} authored-by relationships (${totalLitSkipped} skipped: ${skippedNoOrg} no org, ${skippedNoLink} no link, ${skippedOrgNotFound} org not found, ${skippedUrlNotFound} URL not found)`,
    );
    totalItems += items.length;
    totalSkipped += totalLitSkipped;

    const synced = await batchSync(items, dryRun);
    totalSynced += synced;
    if (!dryRun) console.log(`  Synced ${synced} rows`);
  }

  // Pass 4: author_entity_ids (person → resource authored-by)
  if (source === "all" || source === "author") {
    // Enforce global limit: subtract resources already fetched in pass 1
    const globalLimit = options.limit ? parseInt(options.limit, 10) : Infinity;
    const remaining = Math.max(0, globalLimit - totalResourcesFetched);
    if (remaining === 0 && options.limit) {
      console.log("Pass 4: Skipped (global --limit already reached)");
    } else {
      const passOptions = options.limit
        ? { ...options, limit: String(remaining) }
        : options;
      console.log("Pass 4: Seeding from author_entity_ids...");
      const { items, resourcesFetched } = await seedFromAuthorEntityIds(passOptions);
      console.log(`  Found ${items.length} person-authored relationships`);
      totalItems += items.length;
      totalResourcesFetched += resourcesFetched;

      const synced = await batchSync(items, dryRun);
      totalSynced += synced;
      if (!dryRun) console.log(`  Synced ${synced} rows`);
    }
  }

  console.log(
    `\nTotal: ${totalItems} items${dryRun ? " (dry run)" : `, ${totalSynced} synced`}, ${totalSkipped} skipped`,
  );

  return { exitCode: 0, output: '' };
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
  --source      Restrict to: publisher | wiki_citation | literature | author | all (default: all)
  --limit       Max resources to process (publisher/author passes only)

Data sources:
  publisher       Resources with publisher_entity_id → authoredByEntity=true
  wiki_citation   pageResources mapping → isSubject=true
  literature      literature.yaml org+link → authoredByEntity=true
  author          author_entity_ids on resources → authoredByEntity=true (person→paper)
`;
}
