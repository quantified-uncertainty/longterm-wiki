#!/usr/bin/env node

/**
 * Orphan Entity Detection
 *
 * Detects PG entity records that have no corresponding YAML source file.
 * These "ghost" entities appear on directory pages but link to 404s.
 *
 * The check:
 *   1. Loads all entity IDs from data/entities/*.yaml + KB things
 *   2. Queries the wiki-server for all PG entities
 *   3. Reports PG entities that have no YAML source
 *   4. With --fix, prunes them via the /api/entities/prune endpoint
 *
 * Network dependency: Requires wiki-server access. If unavailable, the check
 * is skipped gracefully (fail-open) since it cannot verify without PG data.
 *
 * Usage:
 *   npx tsx crux/validate/validate-orphan-entities.ts
 *   npx tsx crux/validate/validate-orphan-entities.ts --fix
 *   npx tsx crux/validate/validate-orphan-entities.ts --ci
 *
 * Exit codes:
 *   0 = No orphan entities found (or server unavailable — skipped)
 *   1 = Orphan entities found
 */

import { fileURLToPath } from "url";
import { getColors } from "../lib/output.ts";
import type { ValidatorResult, ValidatorOptions } from "./types.ts";
import type { Colors } from "../lib/output.ts";
import {
  loadEntityYamls,
  loadKBOnlyEntities,
} from "../wiki-server/sync-entities.ts";
import {
  getServerUrl,
  apiRequest,
  type ApiResult,
} from "../lib/wiki-server/client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PgEntityRecord {
  id: string;
  entityType: string;
  title: string;
  stableId?: string | null;
}

export interface OrphanEntity {
  id: string;
  entityType: string;
  title: string;
  stableId?: string | null;
}

export interface OrphanDetectionResult {
  orphans: OrphanEntity[];
  yamlCount: number;
  pgCount: number;
  serverAvailable: boolean;
  pruned?: { deleted: number; ids: string[] };
}

interface PgListResponse {
  entities: PgEntityRecord[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Core detection logic (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Load all entity IDs from YAML source files.
 * Returns a Set of entity slug IDs (the `id` field in YAML).
 */
export function loadYamlEntityIds(): Set<string> {
  const { entities: yamlEntities } = loadEntityYamls();
  const ids = new Set(yamlEntities.map((e) => e.id));

  // Also include KB-only entities (FactBase things not in entity YAML)
  const kbEntities = loadKBOnlyEntities(ids);
  for (const e of kbEntities) {
    ids.add(e.id);
  }

  return ids;
}

/**
 * Fetch all entity records from PG via the wiki-server API.
 * Paginates through all results since the API has a max page size of 500.
 *
 * Note: Uses getServerUrl() internally (via apiRequest) for the server URL.
 * Offset-based pagination may skip or duplicate entities if rows are inserted
 * mid-pagination, but this is acceptable for a read-only gate check.
 */
export async function fetchAllPgEntities(): Promise<ApiResult<PgEntityRecord[]>> {
  const PAGE_SIZE = 500;
  const MAX_PAGES = 100; // Safety cap: 50,000 entities should be plenty
  const allEntities: PgEntityRecord[] = [];
  let offset = 0;
  let total = Infinity;
  let pageCount = 0;

  while (offset < total && pageCount < MAX_PAGES) {
    pageCount++;
    const result = await apiRequest<PgListResponse>(
      "GET",
      `/api/entities?limit=${PAGE_SIZE}&offset=${offset}`,
    );

    if (!result.ok) {
      return result;
    }

    allEntities.push(...result.data.entities);
    total = result.data.total;
    offset += PAGE_SIZE;
  }

  if (pageCount >= MAX_PAGES) {
    console.warn(
      `  WARN: Pagination capped at ${MAX_PAGES} pages (${allEntities.length} entities fetched, server reports ${total} total)`,
    );
  }

  return { ok: true, data: allEntities };
}

/**
 * Detect orphan entities: PG records with no YAML source.
 */
export function detectOrphans(
  yamlIds: Set<string>,
  pgEntities: PgEntityRecord[],
): OrphanEntity[] {
  return pgEntities
    .filter((pg) => !yamlIds.has(pg.id))
    .map((pg) => ({
      id: pg.id,
      entityType: pg.entityType,
      title: pg.title,
      stableId: pg.stableId,
    }));
}

// ---------------------------------------------------------------------------
// Prune logic
// ---------------------------------------------------------------------------

/** Maximum fraction of PG entities that can be pruned in one run. */
export const PRUNE_SAFETY_THRESHOLD = 0.2;

/**
 * Prune orphan entities via the wiki-server API.
 * Groups by entity type and calls the prune endpoint for each type.
 * Aborts if the orphan ratio exceeds PRUNE_SAFETY_THRESHOLD to prevent
 * mass deletion when YAML loading fails partially.
 */

async function pruneOrphans(
  orphans: OrphanEntity[],
  yamlIds: Set<string>,
  pgEntities: PgEntityRecord[],
): Promise<{ deleted: number; ids: string[] }> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return { deleted: 0, ids: [] };
  }

  // Safety threshold: abort if the orphan ratio is suspiciously high.
  // This protects against mass deletion when YAML loading fails partially
  // (e.g., data/entities/ directory missing, parse errors on most files).
  if (pgEntities.length > 0) {
    const orphanRatio = orphans.length / pgEntities.length;
    if (orphanRatio > PRUNE_SAFETY_THRESHOLD) {
      console.error(
        `  SAFETY: ${orphans.length}/${pgEntities.length} (${(orphanRatio * 100).toFixed(0)}%) would be pruned. ` +
          `This exceeds the ${(PRUNE_SAFETY_THRESHOLD * 100).toFixed(0)}% safety threshold. ` +
          `Aborting prune. This usually indicates YAML loading failed.`,
      );
      return { deleted: 0, ids: [] };
    }
  }

  // Group all YAML IDs by entity type (from PG records, since we need the types)
  const keepIdsByType = new Map<string, string[]>();
  for (const pg of pgEntities) {
    if (yamlIds.has(pg.id)) {
      const ids = keepIdsByType.get(pg.entityType) ?? [];
      ids.push(pg.id);
      keepIdsByType.set(pg.entityType, ids);
    }
  }

  // Also include orphan entity types that might not have any YAML entities
  const orphanTypes = new Set(orphans.map((o) => o.entityType));
  for (const t of orphanTypes) {
    if (!keepIdsByType.has(t)) {
      // This type only has orphans — we need at least one keepId for the API
      // The prune endpoint requires keepIds.min(1), so we handle this case
      // by collecting all YAML IDs of this type (which is 0) and sending
      // a direct delete instead. For safety, skip types with no YAML entries.
      console.warn(
        `  WARN: Entity type "${t}" has orphans but no YAML entities — skipping prune (manual review needed)`,
      );
    }
  }

  let totalDeleted = 0;
  const allDeletedIds: string[] = [];

  for (const [entityType, keepIds] of keepIdsByType) {
    if (!orphanTypes.has(entityType)) continue; // No orphans of this type

    try {
      const result = await apiRequest<{ deleted: number; ids: string[] }>(
        "POST",
        "/api/entities/prune",
        { entityType, keepIds },
      );

      if (!result.ok) {
        console.warn(
          `  Prune ${entityType}: failed — ${result.message}`,
        );
        continue;
      }

      if (result.data.deleted > 0) {
        console.log(
          `  Pruned ${result.data.deleted} orphan ${entityType} entities: ${result.data.ids.join(", ")}`,
        );
        totalDeleted += result.data.deleted;
        allDeletedIds.push(...result.data.ids);
      }
    } catch (err) {
      console.warn(
        `  Prune ${entityType}: error — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { deleted: totalDeleted, ids: allDeletedIds };
}

// ---------------------------------------------------------------------------
// runCheck (for orchestrator / gate)
// ---------------------------------------------------------------------------

export async function runCheck(
  options: ValidatorOptions = {},
): Promise<ValidatorResult> {
  const ciMode = options.ci ?? false;
  const fixMode = options.fix ?? false;
  const colors: Colors = getColors(ciMode);

  const serverUrl = getServerUrl();

  // Fail-open: if wiki-server is not configured, skip gracefully.
  // This check depends on network access to query PG entities.
  if (!serverUrl) {
    if (!ciMode) {
      console.log(
        `${colors.dim}Orphan entity check skipped — LONGTERMWIKI_SERVER_URL not set${colors.reset}`,
      );
    }
    return { passed: true, errors: 0, warnings: 1 };
  }

  if (!ciMode) {
    console.log(
      `${colors.blue}Checking for orphan entities (PG records without YAML source)...${colors.reset}\n`,
    );
  }

  // 1. Load YAML entity IDs
  const yamlIds = loadYamlEntityIds();
  if (!ciMode) {
    console.log(`  YAML entities: ${yamlIds.size}`);
  }

  // 2. Fetch all PG entities
  const pgResult = await fetchAllPgEntities();

  if (!pgResult.ok) {
    // Fail-open: wiki-server is unreachable or errored.
    // Log warning but don't block the gate — this is a network dependency.
    if (!ciMode) {
      console.log(
        `${colors.yellow}  Wiki-server unavailable (${pgResult.message}) — skipping orphan check${colors.reset}`,
      );
    }
    return { passed: true, errors: 0, warnings: 1 };
  }

  const pgEntities = pgResult.data;
  if (!ciMode) {
    console.log(`  PG entities:   ${pgEntities.length}`);
  }

  // 3. Detect orphans
  const orphans = detectOrphans(yamlIds, pgEntities);

  // 4. Report results
  const result: OrphanDetectionResult = {
    orphans,
    yamlCount: yamlIds.size,
    pgCount: pgEntities.length,
    serverAvailable: true,
  };

  if (ciMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (orphans.length === 0) {
      console.log(
        `\n${colors.green}  No orphan entities found${colors.reset}`,
      );
    } else {
      console.log(
        `\n${colors.yellow}  Found ${orphans.length} orphan entities (PG records without YAML source):${colors.reset}\n`,
      );

      // Group by entity type for readability
      const byType = new Map<string, OrphanEntity[]>();
      for (const o of orphans) {
        const list = byType.get(o.entityType) ?? [];
        list.push(o);
        byType.set(o.entityType, list);
      }

      for (const [type, entities] of byType) {
        console.log(`  ${colors.dim}${type}:${colors.reset}`);
        for (const e of entities) {
          console.log(
            `    ${colors.yellow}${e.id}${colors.reset} — ${e.title}`,
          );
        }
      }

      if (fixMode) {
        console.log(
          `\n${colors.cyan}  Pruning orphan entities...${colors.reset}`,
        );
        const pruned = await pruneOrphans(orphans, yamlIds, pgEntities);
        result.pruned = pruned;

        if (pruned.deleted > 0) {
          console.log(
            `\n${colors.green}  Pruned ${pruned.deleted} orphan entities${colors.reset}`,
          );
        } else {
          console.log(
            `\n${colors.yellow}  No entities were pruned (check warnings above)${colors.reset}`,
          );
        }
      } else {
        console.log(
          `\n${colors.dim}  Run with --fix to prune orphan entities from PG${colors.reset}`,
        );
      }
    }
  }

  const hasOrphans = orphans.length > 0 && !fixMode;
  return {
    passed: !hasOrphans,
    errors: hasOrphans ? orphans.length : 0,
    warnings: 0,
  };
}

// ---------------------------------------------------------------------------
// Standalone main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = await runCheck({
    ci: args.includes("--ci"),
    fix: args.includes("--fix"),
  });
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
