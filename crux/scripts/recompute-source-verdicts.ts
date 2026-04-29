#!/usr/bin/env -S node --import tsx/esm
/**
 * One-time backfill: recompute every sourcing verdict from its
 * underlying evidence rows (QUA-791).
 *
 * The pre-Phase-1 `POST /verdicts` endpoint was last-writer-wins —
 * whoever wrote last set the aggregate, regardless of the other
 * evidence rows. Post-QUA-791, every new write triggers server-side
 * recompute. This script reconciles the *existing* table by listing
 * every `(record_type, record_id, field_name)` key with a verdict and
 * POSTing `/api/sourcing/verdicts/recompute` for each.
 *
 * **Concurrent-write caveat**: `/api/sourcing/verdicts` orders by
 * `lastComputedAt desc`, so under active enrichment the cursor can
 * skip rows. Recompute is idempotent — duplicates are harmless — but
 * skipped keys remain on the legacy aggregate. Run during low-write
 * periods or accept that ~1-5% of keys may need a follow-up POST
 * /evidence to pick up the recompute.
 *
 * Usage:
 *   node --import tsx/esm crux/scripts/recompute-source-verdicts.ts             # dry run
 *   node --import tsx/esm crux/scripts/recompute-source-verdicts.ts --apply     # write
 *   node --import tsx/esm crux/scripts/recompute-source-verdicts.ts --apply --limit=100
 *   WIKI_SERVER_ENV=prod node --import tsx/esm crux/scripts/recompute-source-verdicts.ts
 *
 * Flags:
 *   --apply           Actually call the recompute endpoint (default: dry-run, samples 5 keys)
 *   --limit=N         Process at most N keys
 *   --concurrency=N   Parallel requests (default: 5)
 */

import "dotenv/config";
import {
  listVerdicts,
  recomputeVerdict,
} from "../lib/wiki-server/sourcing-client.ts";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const limitArg = args.find((a) => a.startsWith("--limit="));
const concurrencyArg = args.find((a) => a.startsWith("--concurrency="));

function parsePositiveInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.error(`ERROR: --${name}=${raw} must be a positive integer`);
    process.exit(2);
  }
  return n;
}

const LIMIT = limitArg ? parsePositiveInt(limitArg.split("=")[1], "limit") : undefined;
const CONCURRENCY = concurrencyArg
  ? parsePositiveInt(concurrencyArg.split("=")[1], "concurrency")
  : 5;

interface EvidenceKey {
  recordType: string;
  recordId: string;
  fieldName: string | null;
}

/**
 * Single paginated walk of `/api/sourcing/verdicts` that returns both
 * the verdict-key list (input to recompute) and the verdict-distribution
 * map (the "before" snapshot for diffing).
 */
async function fetchVerdictKeysAndDistribution(): Promise<{
  keys: EvidenceKey[];
  distribution: Map<string, number>;
}> {
  const keys: EvidenceKey[] = [];
  const distribution = new Map<string, number>();
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const result = await listVerdicts({ limit: pageSize, offset });
    if (!result.ok) {
      throw new Error(`list verdicts failed: ${result.error}`);
    }
    const { verdicts, total } = result.data;
    if (!verdicts || verdicts.length === 0) break;
    for (const v of verdicts) {
      keys.push({
        recordType: v.recordType,
        recordId: v.recordId,
        fieldName: v.fieldName ?? null,
      });
      distribution.set(v.verdict, (distribution.get(v.verdict) ?? 0) + 1);
      if (LIMIT && keys.length >= LIMIT) {
        return { keys, distribution };
      }
    }
    offset += verdicts.length;
    if (offset >= total) break;
  }
  return { keys, distribution };
}

/** Diff-only walk for the "after" snapshot. */
async function fetchVerdictDistribution(): Promise<Map<string, number>> {
  const distribution = new Map<string, number>();
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const result = await listVerdicts({ limit: pageSize, offset });
    if (!result.ok) {
      throw new Error(`list verdicts failed: ${result.error}`);
    }
    const { verdicts, total } = result.data;
    if (!verdicts || verdicts.length === 0) break;
    for (const v of verdicts) {
      distribution.set(v.verdict, (distribution.get(v.verdict) ?? 0) + 1);
    }
    offset += verdicts.length;
    if (offset >= total) break;
  }
  return distribution;
}

async function recomputeOne(
  key: EvidenceKey,
): Promise<{ verdict: string; key: EvidenceKey } | null> {
  const result = await recomputeVerdict({
    recordType: key.recordType,
    recordId: key.recordId,
    fieldName: key.fieldName,
  });
  if (!result.ok) {
    console.error(
      `recompute failed for ${key.recordType}/${key.recordId}/${key.fieldName ?? "null"}: ${result.error}`,
    );
    return null;
  }
  return { verdict: result.data.verdict, key };
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const next = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      const r = await worker(items[idx]);
      results.push(r);
      if ((idx + 1) % 100 === 0) {
        console.log(`  ${idx + 1}/${items.length} processed`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => next()));
  return results;
}

function printDistribution(label: string, dist: Map<string, number>): void {
  console.log(`${label}:`);
  const sorted = [...dist.entries()].sort((a, b) => b[1] - a[1]);
  for (const [verdict, count] of sorted) {
    console.log(`  ${verdict.padEnd(15)} ${count}`);
  }
}

async function main(): Promise<void> {
  console.log(`Mode: ${APPLY ? "APPLY (will write)" : "DRY RUN (samples 5 keys)"}`);
  if (LIMIT) console.log(`Limit: ${LIMIT}`);
  console.log("");

  console.log("Listing keys + baseline distribution...");
  const { keys, distribution: before } = await fetchVerdictKeysAndDistribution();
  console.log(`  ${keys.length} keys`);
  printDistribution("Baseline", before);
  console.log("");

  if (!APPLY) {
    console.log("DRY RUN — sampling 5 keys:");
    for (const key of keys.slice(0, 5)) {
      const r = await recomputeOne(key);
      if (r) {
        console.log(`  ${key.recordType}/${key.recordId}/${key.fieldName ?? "null"} → ${r.verdict}`);
      }
    }
    console.log("\nRe-run with --apply to recompute all keys.");
    return;
  }

  console.log(`Recomputing ${keys.length} keys with concurrency=${CONCURRENCY}...`);
  const t0 = Date.now();
  const results = await runWithConcurrency(keys, CONCURRENCY, recomputeOne);
  const elapsedSec = Math.round((Date.now() - t0) / 1000);
  const ok = results.filter((r) => r !== null).length;
  const failed = results.length - ok;
  console.log(`  ${ok} succeeded, ${failed} failed in ${elapsedSec}s\n`);

  console.log("Fetching post-recompute distribution...");
  const after = await fetchVerdictDistribution();
  printDistribution("After", after);

  console.log("\nDiff (after - before):");
  const verdicts = new Set([...before.keys(), ...after.keys()]);
  for (const v of verdicts) {
    const beforeCount = before.get(v) ?? 0;
    const afterCount = after.get(v) ?? 0;
    const delta = afterCount - beforeCount;
    if (delta === 0) continue;
    const sign = delta > 0 ? "+" : "";
    console.log(`  ${v.padEnd(15)} ${beforeCount} → ${afterCount} (${sign}${delta})`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
