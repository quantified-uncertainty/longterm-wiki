/**
 * Import grants from external sources into wiki-server Postgres.
 *
 * Sources:
 *   1. Coefficient Giving (Open Philanthropy) grants archive CSV
 *   2. EA Funds public grants CSV
 *   3. Survival and Flourishing Fund (SFF) HTML table
 *   4. FTX Future Fund (historical, pre-collapse) — Vipul Naik donations repo
 *   5. Manifund projects API
 *
 * Usage:
 *   pnpm crux import-grants analyze                  # All 5 sources
 *   pnpm crux import-grants analyze --source=sff     # Just SFF
 *   pnpm crux import-grants sync --source=manifund   # Just Manifund
 *   pnpm crux import-grants sync --dry-run           # All, dry run
 */

import { buildEntityMatcher } from "../lib/grant-import/entity-matcher.ts";
import { toSyncGrant, syncToServer } from "../lib/grant-import/sync.ts";
import { apiRequest } from "../lib/wiki-server/client.ts";
import {
  printMatchStats,
  printTopUnmatched,
  checkIdCollisions,
  printByFunder,
  printProgramMatchStats,
} from "../lib/grant-import/analysis.ts";
import { printDuplicateAnalysis, deduplicateGrants } from "../lib/grant-import/dedup.ts";
import { ALL_SOURCES } from "../lib/grant-import/sources/index.ts";
import type { GrantSource, RawGrant, SyncGrant } from "../lib/grant-import/types.ts";

/** Map from source ID to sourceUrl, built once from ALL_SOURCES */
const SOURCE_URL_MAP = new Map(ALL_SOURCES.map(s => [s.id, s.sourceUrl]));

function sourceUrlFor(sourceId: string): string {
  const url = SOURCE_URL_MAP.get(sourceId);
  if (!url) {
    throw new Error(
      `No sourceUrl found for source ID "${sourceId}". Known sources: ${[...SOURCE_URL_MAP.keys()].join(", ")}`
    );
  }
  return url;
}

function filterSources(sourceFilter?: string): GrantSource[] {
  if (!sourceFilter) return ALL_SOURCES;
  const src = ALL_SOURCES.find(s => s.id === sourceFilter);
  if (!src) {
    throw new Error(
      `Unknown source: ${sourceFilter}. Available: ${ALL_SOURCES.map(s => s.id).join(", ")}`
    );
  }
  return [src];
}

async function cmdAnalyze(sourceFilter?: string) {
  const sources = filterSources(sourceFilter);
  const matcher = buildEntityMatcher();

  console.log("=== Grant Import Analysis ===\n");

  const allGrants: RawGrant[] = [];

  for (const src of sources) {
    await src.ensureData();
    const grants = await src.parse(matcher);
    const total = grants.reduce((s, g) => s + (g.amount || 0), 0);

    const scale = total > 1e9 ? `$${(total / 1e9).toFixed(2)}B` : `$${(total / 1e6).toFixed(1)}M`;
    console.log(`${src.name}: ${grants.length} grants (${scale})`);

    if (src.printAnalysis) {
      src.printAnalysis(grants);
    }

    allGrants.push(...grants);
  }

  if (sources.length > 1) {
    const grandTotal = allGrants.reduce((s, g) => s + (g.amount || 0), 0);
    console.log(`\nTotal: ${allGrants.length} grants ($${(grandTotal / 1e9).toFixed(2)}B)\n`);
  } else {
    console.log("");
  }

  printMatchStats(allGrants);
  printProgramMatchStats(allGrants);
  printTopUnmatched(allGrants);

  const syncGrants = allGrants.map(g => {
    return toSyncGrant(g, sourceUrlFor(g.source));
  });
  checkIdCollisions(syncGrants);
  printByFunder(syncGrants);

  // Cross-source duplicate analysis
  if (sources.length > 1) {
    printDuplicateAnalysis(allGrants);
  }
}

async function cmdSync(dryRun: boolean, sourceFilter?: string, dedup = true) {
  const sources = filterSources(sourceFilter);
  const matcher = buildEntityMatcher();

  let allGrants: RawGrant[] = [];

  for (const src of sources) {
    await src.ensureData();
    const grants = await src.parse(matcher);
    console.log(`${src.name}: ${grants.length} grants`);
    allGrants.push(...grants);
  }

  console.log(`Total: ${allGrants.length} grants`);

  // Cross-source deduplication (on by default, disable with --no-dedup)
  if (dedup && sources.length > 1) {
    const { deduplicated, removed } = deduplicateGrants(allGrants);
    if (removed > 0) {
      console.log(`Cross-source dedup: removed ${removed} likely duplicates`);
    }
    allGrants = deduplicated;
  }

  // Convert and deduplicate by ID
  const syncMap = new Map<string, SyncGrant>();
  let collisions = 0;
  for (const raw of allGrants) {
    const sync = toSyncGrant(raw, sourceUrlFor(raw.source));
    if (syncMap.has(sync.id)) collisions++;
    syncMap.set(sync.id, sync);
  }
  const syncGrants = [...syncMap.values()];
  console.log(`After dedup: ${syncGrants.length} unique grants`);
  if (collisions > 0) {
    console.warn(`  (${collisions} ID collisions resolved by dedup)`);
  }

  await syncToServer(syncGrants, dryRun);
}

// ---------------------------------------------------------------------------
// Crux command exports
// ---------------------------------------------------------------------------

type CommandResult = { exitCode?: number; output?: string };

async function analyzeCommand(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const sourceFilter = (options.source as string) || undefined;
  await cmdAnalyze(sourceFilter);
  return { exitCode: 0 };
}

async function syncCommand(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const dryRun = !!options.dryRun || !!options["dry-run"];
  const sourceFilter = (options.source as string) || undefined;
  const noDedup = !!options["no-dedup"] || !!options.noDedup;
  await cmdSync(dryRun, sourceFilter, !noDedup);
  return { exitCode: 0 };
}

async function downloadCommand(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const sourceFilter = (options.source as string) || undefined;
  const sources = filterSources(sourceFilter);
  for (const src of sources) {
    await src.ensureData();
  }
  return { exitCode: 0 };
}

async function dedupCommand(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const dryRun = !!options.dryRun || !!options["dry-run"];
  const sources = ALL_SOURCES;
  const matcher = buildEntityMatcher();

  // Re-import all grants from all sources (skip sources that fail)
  let allGrants: RawGrant[] = [];
  for (const src of sources) {
    try {
      await src.ensureData();
      const grants = await src.parse(matcher);
      console.log(`${src.name}: ${grants.length} grants`);
      allGrants.push(...grants);
    } catch (e) {
      console.warn(`${src.name}: skipped (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  console.log(`Total from sources: ${allGrants.length} grants`);

  // Run dedup to find which grants to keep
  const { deduplicated, removed } = deduplicateGrants(allGrants);
  console.log(`After dedup: ${deduplicated.length} (removed ${removed})`);

  // Convert to sync grants to get deterministic IDs
  const keepIds = new Set<string>();
  for (const raw of deduplicated) {
    const sync = toSyncGrant(raw, sourceUrlFor(raw.source));
    keepIds.add(sync.id);
  }

  const allIds = new Set<string>();
  for (const raw of allGrants) {
    const sync = toSyncGrant(raw, sourceUrlFor(raw.source));
    allIds.add(sync.id);
  }

  // IDs to delete = allIds - keepIds
  const deleteIds = [...allIds].filter(id => !keepIds.has(id));
  console.log(`\nGrants to delete: ${deleteIds.length}`);
  console.log(`Grants to keep: ${keepIds.size}`);

  if (deleteIds.length === 0) {
    return { exitCode: 0, output: "No duplicates found." };
  }

  if (dryRun) {
    console.log("\n(dry run — no deletions performed)");
    console.log(`Would delete ${deleteIds.length} duplicate grant IDs`);
    return { exitCode: 0 };
  }

  // Delete in batches of 500
  const BATCH_SIZE = 500;
  let totalDeleted = 0;
  for (let i = 0; i < deleteIds.length; i += BATCH_SIZE) {
    const batch = deleteIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(deleteIds.length / BATCH_SIZE);

    console.log(`  Deleting batch ${batchNum}/${totalBatches}: ${batch.length} grants...`);

    const result = await apiRequest<{ deleted: number }>(
      "POST",
      "/api/grants/delete-batch",
      { ids: batch },
    );

    if (result.ok) {
      totalDeleted += result.data.deleted;
    } else {
      console.error(`  ✗ Batch ${batchNum} failed:`, result.error);
    }
  }

  return {
    exitCode: 0,
    output: `\nDeleted ${totalDeleted} duplicate grants. Run 'crux import-grants sync' to re-sync clean data.`,
  };
}

export const commands = {
  analyze: analyzeCommand,
  sync: syncCommand,
  download: downloadCommand,
  dedup: dedupCommand,
  default: analyzeCommand,
};

export function getHelp(): string {
  return `
Import Grants — Import external grant databases into wiki-server Postgres

Commands:
  analyze              Preview import stats and entity matching
  sync                 Import grants to wiki-server (dedup on by default)
  sync --dry-run       Show what would be synced without writing
  dedup                Remove cross-source duplicates from the database
  dedup --dry-run      Show what would be removed without deleting
  download             Just download data files

Options:
  --source=<id>        Filter to a single source (default: all)
  --no-dedup           Disable cross-source deduplication during sync
  --dry-run            Preview without writing

Sources:
  ${ALL_SOURCES.map(s => `- ${s.id} (${s.name})`).join("\n  ")}
`;
}
