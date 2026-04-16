/**
 * Wiki Server Facts Sync
 *
 * Reads all KB YAML facts from packages/factbase/data/fb-entities/ and bulk-upserts
 * them to the wiki-server's /api/facts/sync endpoint.
 *
 * Reuses the shared batch sync infrastructure from sync-common.ts.
 *
 * Usage:
 *   pnpm crux wiki-server sync-facts
 *   pnpm crux wiki-server sync-facts --dry-run
 *   pnpm crux wiki-server sync-facts --batch-size=200
 *   pnpm crux wiki-server sync-facts --skip-prune
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL   - Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY - Bearer token for authentication
 */

import { join } from "path";
import { fileURLToPath } from "url";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey, buildHeaders } from "../lib/wiki-server/client.ts";
import { loadKB } from "../../packages/factbase/src/loader.ts";
import type { Fact, FactValue, Property } from "../../packages/factbase/src/types.ts";
import type { SyncFact } from "../../apps/wiki-server/src/api-types.ts";
import type { PruneFactsResult } from "../lib/wiki-server/facts.ts";
import { waitForHealthy, batchSync, fetchWithRetry } from "./sync-common.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const KB_DATA_DIR = join(PROJECT_ROOT, "packages", "factbase", "data");

// --- Configuration ---
const DEFAULT_BATCH_SIZE = 500;
/**
 * Max number of (entityId → factIds) entries per /prune request. The server
 * caps this at 5000 entries; we batch at 1000 so a single bad batch never
 * blocks more than 1/5 of the total work, so the per-request in-memory SELECT
 * + DELETE work stays bounded, and so log output is split into multiple
 * lines for legibility.
 */
const PRUNE_BATCH_SIZE = 1000;
/**
 * Mirror of the server's per-entry `factIds` cap (2000). We assert at
 * request-build time so a single oversized entity fails the CLI loudly
 * instead of being silently dropped as a batch 400 by the retry loop.
 */
const PRUNE_MAX_FACT_IDS_PER_ENTITY = 2000;

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
    // property.name is the human-readable label ("Revenue", "Employed By").
    // Without this, the server's things-table dual-write falls back to fact.id
    // (e.g. "f_mEKUPPFYRg"), baking raw FactBase IDs into things.title and
    // things.description — visible to users on /organizations/*/data (QUA-397).
    label: property?.name ?? null,
    value: serializeValue(fact.value),
    numeric: extractNumeric(fact.value),
    low,
    high,
    asOf: fact.asOf ?? null,
    validEnd: fact.validEnd ?? null,
    currency: fact.currency ?? null,
    measure: fact.propertyId,
    subject: fact.subjectId,
    note: fact.notes ?? null,
    source: fact.source ?? null,
    format: fact.value.type,
    formatDivisor: property?.display?.divisor ?? null,
    sourceQuote: fact.sourceQuote ?? null,
    usdEquivalent: fact.usdEquivalent ?? null,
    exchangeRate: fact.exchangeRate ?? null,
    exchangeRateDate: fact.exchangeRateDate ?? null,
    dollarYear: fact.dollarYear ?? null,
  };
}

/**
 * Load all KB facts and transform them into SyncFact payloads.
 *
 * Also returns `entityIdsWithNoFacts`: KB entities that exist in YAML but
 * emitted zero source facts after filtering derived/inverse facts. This is
 * the QUA-462 constellation case — the entity is still in the KB but its
 * `things/<entity>.yaml` file was emptied. Without this, the prune step has
 * no way to know about the entity (it never appears in the syncFacts list)
 * and orphan PG facts for it leak forever.
 *
 * Exported for testing.
 */
export async function loadAndTransformFacts(
  dataDir: string = KB_DATA_DIR,
): Promise<{
  facts: SyncFact[];
  entityCount: number;
  entityIdsWithNoFacts: string[];
}> {
  const { graph } = await loadKB(dataDir);
  const allEntities = graph.getAllEntities();
  const syncFacts: SyncFact[] = [];
  const entityIdsWithNoFacts: string[] = [];

  for (const entity of allEntities) {
    const facts = graph.getFacts(entity.id);
    let kept = 0;
    for (const fact of facts) {
      // Skip derived/inverse facts — they are computed, not source data
      if (fact.derivedFrom) continue;
      const property = graph.getProperty(fact.propertyId);
      syncFacts.push(transformFact(fact, property));
      kept++;
    }
    if (kept === 0) {
      entityIdsWithNoFacts.push(entity.id);
    }
  }

  return {
    facts: syncFacts,
    entityCount: allEntities.length,
    entityIdsWithNoFacts,
  };
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

/**
 * Group facts by entityId into `{ entityId, factIds }` entries suitable for
 * the /prune endpoint. Each entry must contain the COMPLETE keep set for its
 * entityId — the server deletes any fact in PG for that entity whose factId
 * isn't listed.
 *
 * Callers should pass `entityIdsWithNoFacts` for entities present in the KB
 * but emitting zero source facts (e.g. the constellation.yaml → facts: []
 * case from QUA-462). Those entities are added with empty factIds so the
 * prune endpoint clears their remaining PG rows. Without this, such entities
 * would be invisible to the prune (they never appear in `items`) and their
 * orphan facts would leak forever.
 *
 * Exported for testing. Throws if any single entity has more factIds than
 * the server accepts — see PRUNE_MAX_FACT_IDS_PER_ENTITY.
 */
export function groupFactsByEntity(
  items: SyncFact[],
  entityIdsWithNoFacts: string[] = [],
): Array<{ entityId: string; factIds: string[] }> {
  const byEntity = new Map<string, string[]>();
  for (const f of items) {
    const ids = byEntity.get(f.entityId) ?? [];
    ids.push(f.factId);
    byEntity.set(f.entityId, ids);
  }
  for (const eid of entityIdsWithNoFacts) {
    if (!byEntity.has(eid)) byEntity.set(eid, []);
  }
  // Fail loudly if a single entity exceeds the server's per-entry cap. The
  // 2000 limit matches real-world data (avg ~4 facts/entity, max <100) with a
  // 20x headroom, but a future bug that bloats an entity would otherwise be
  // silently dropped by the retry loop on a batch 400.
  for (const [entityId, factIds] of byEntity) {
    if (factIds.length > PRUNE_MAX_FACT_IDS_PER_ENTITY) {
      throw new Error(
        `groupFactsByEntity: entity "${entityId}" has ${factIds.length} facts, ` +
          `exceeding the per-entry cap of ${PRUNE_MAX_FACT_IDS_PER_ENTITY}. ` +
          `Investigate why a single entity has so many facts before bumping the cap.`,
      );
    }
  }
  return Array.from(byEntity, ([entityId, factIds]) => ({ entityId, factIds }));
}

export interface PruneFactsOutcome {
  /** Total facts deleted across all successful batches. */
  deleted: number;
  /** Sample of deleted IDs (capped to avoid unbounded memory in the caller). */
  ids: Array<{ entityId: string; factId: string }>;
  /** Number of batches that failed (HTTP error or thrown exception). */
  errors: number;
}

/**
 * Prune stale facts from PG that are no longer in the YAML source.
 *
 * Sends batches of (entityId, factIds) entries to /api/facts/prune. The server
 * deletes any fact in PG whose entityId is in the batch but whose factId is
 * NOT in the keep list — facts for entities not in the request are untouched,
 * so a partial sync cannot delete cross-entity data.
 *
 * Batch failures are counted in `errors` and logged at ERROR level. The
 * caller (sync-facts `main()`) should surface the count so operators don't
 * see a falsely "clean" run after a prune 400s.
 *
 * Exported for testing.
 */
export async function pruneFacts(
  serverUrl: string,
  items: SyncFact[],
  entityIdsWithNoFacts: string[] = [],
  options: { batchSize?: number } = {},
): Promise<PruneFactsOutcome> {
  const batchSize = options.batchSize ?? PRUNE_BATCH_SIZE;
  const entries = groupFactsByEntity(items, entityIdsWithNoFacts);

  if (entries.length === 0) {
    return { deleted: 0, ids: [], errors: 0 };
  }

  let totalDeleted = 0;
  let totalErrors = 0;
  const allDeletedIds: Array<{ entityId: string; factId: string }> = [];

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    try {
      const res = await fetchWithRetry(
        `${serverUrl}/api/facts/prune`,
        {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify({ entries: batch }),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        console.error(
          `  Prune batch ${batchNum}: HTTP ${res.status} — ${body.slice(0, 200)}`,
        );
        totalErrors++;
        continue;
      }

      // The response shape is inferred from the Hono RPC route type so the
      // client and server cannot drift silently — see PruneFactsResult in
      // crux/lib/wiki-server/facts.ts.
      const result = (await res.json()) as PruneFactsResult;
      if (result.deleted > 0) {
        const sample = result.ids
          .slice(0, 5)
          .map((x) => `${x.entityId}/${x.factId}`)
          .join(", ");
        const more = result.deleted > 5 ? ` ...(+${result.deleted - 5} more)` : "";
        const truncatedNote = result.truncated ? " [ids truncated]" : "";
        console.log(
          `  Prune batch ${batchNum}: removed ${result.deleted} stale facts: ${sample}${more}${truncatedNote}`,
        );
        totalDeleted += result.deleted;
        allDeletedIds.push(...result.ids);
      }
    } catch (err) {
      console.error(
        `  Prune batch ${batchNum}: failed — ${err instanceof Error ? err.message : err}`,
      );
      totalErrors++;
    }
  }

  return { deleted: totalDeleted, ids: allDeletedIds, errors: totalErrors };
}

// --- CLI ---

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const skipPrune = args["skip-prune"] === true;
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
  const { facts, entityCount, entityIdsWithNoFacts } = await loadAndTransformFacts();

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

  // Prune stale facts (those in PG whose factId is no longer in YAML for an
  // entity present in the sync). Skipped if the sync had errors or if the
  // operator opts out — partial syncs must not delete cross-entity data.
  // The result.errors > 0 branch above already process.exit(1)s, but the
  // explicit check here is intentional belt-and-suspenders so a future
  // refactor can't accidentally let the prune fire on a partial sync.
  if (skipPrune) {
    console.log("\nSkipping prune (--skip-prune)");
  } else if (result.errors === 0) {
    console.log("\nPruning stale facts...");
    const pruneResult = await pruneFacts(serverUrl, facts, entityIdsWithNoFacts);
    if (pruneResult.deleted > 0) {
      console.log(`  Pruned: ${pruneResult.deleted} stale facts`);
    } else {
      console.log("  No stale facts to prune");
    }
    // A prune failure is NOT a sync failure (the upsert already succeeded),
    // but it must not masquerade as a clean run either — the 2026-04-14
    // incident that prompted QUA-462 was partly about silent failure. Exit
    // non-zero so operators see the red light in CI.
    if (pruneResult.errors > 0) {
      console.error(
        `  Prune: ${pruneResult.errors} batch(es) failed — see errors above`,
      );
      process.exit(1);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Sync failed:", err);
    process.exit(1);
  });
}
