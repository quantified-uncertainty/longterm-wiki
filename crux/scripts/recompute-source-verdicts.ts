#!/usr/bin/env -S node --import tsx/esm
/**
 * One-time backfill: recompute every source-check verdict from its
 * underlying evidence rows (QUA-791 Phase 1).
 *
 * The pre-Phase-1 `POST /verdicts` endpoint was last-writer-wins —
 * whoever wrote last set the aggregate, regardless of the other
 * evidence rows. After QUA-791 lands, every new write triggers
 * server-side recompute. This script reconciles the *existing* table
 * by reading all distinct `(record_type, record_id, field_name)` keys
 * from `source_check_evidence` and POSTing
 * `/api/sourcing/verdicts/recompute` for each.
 *
 * Reports a verdict-distribution diff (before vs after) so the operator
 * can see the impact before merging.
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
 *
 * Safe to re-run: each call is idempotent on the (recordType, recordId, fieldName) key.
 */

import { config } from "dotenv";
import { join } from "node:path";

config({ path: join(import.meta.dirname, "../../.env") });

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

const isProd = process.env.WIKI_SERVER_ENV === "prod";
const BASE_URL = isProd
  ? process.env.PROD_LONGTERMWIKI_SERVER_URL
  : process.env.LONGTERMWIKI_SERVER_URL ?? "http://localhost:4850";
const API_KEY = isProd
  ? process.env.PROD_LONGTERMWIKI_SERVER_API_KEY
  : process.env.LONGTERMWIKI_SERVER_API_KEY;

if (!BASE_URL) {
  console.error("ERROR: No wiki-server URL configured.");
  process.exit(1);
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  return h;
}

interface DistributionRow {
  verdict: string;
  count: number;
}

/**
 * Pull current verdict distribution by paging through `/api/sourcing/verdicts`.
 * Aggregated client-side because there is no /stats endpoint that returns
 * raw verdict counts unfiltered by orphan-cleanup CTE.
 */
async function fetchVerdictDistribution(): Promise<DistributionRow[]> {
  const counts = new Map<string, number>();
  let offset = 0;
  const pageSize = 200;
  while (true) {
    const url = `${BASE_URL}/api/sourcing/verdicts?limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      throw new Error(`fetch verdicts failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { verdicts: Array<{ verdict: string }>; total: number };
    if (!data.verdicts || data.verdicts.length === 0) break;
    for (const v of data.verdicts) {
      counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
    }
    offset += data.verdicts.length;
    if (offset >= data.total) break;
  }
  return [...counts.entries()]
    .map(([verdict, count]) => ({ verdict, count }))
    .sort((a, b) => b.count - a.count);
}

interface EvidenceKey {
  recordType: string;
  recordId: string;
  fieldName: string | null;
}

/**
 * List every distinct (recordType, recordId, fieldName) key with at least
 * one evidence row. We page through `/api/sourcing/verdicts` because every
 * key with evidence almost certainly has a verdict row already (the old
 * code wrote them in lockstep). Anything we miss this pass — keys with
 * evidence but no verdict — gets picked up the next time POST /evidence
 * fires for that key (which now triggers recompute).
 */
async function listKeys(): Promise<EvidenceKey[]> {
  const keys: EvidenceKey[] = [];
  let offset = 0;
  const pageSize = 500;
  while (true) {
    const url = `${BASE_URL}/api/sourcing/verdicts?limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      throw new Error(`list verdicts failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      verdicts: Array<{ recordType: string; recordId: string; fieldName: string | null }>;
      total: number;
    };
    if (!data.verdicts || data.verdicts.length === 0) break;
    for (const v of data.verdicts) {
      keys.push({
        recordType: v.recordType,
        recordId: v.recordId,
        fieldName: v.fieldName ?? null,
      });
      if (LIMIT && keys.length >= LIMIT) return keys;
    }
    offset += data.verdicts.length;
    if (offset >= data.total) break;
  }
  return keys;
}

async function recompute(key: EvidenceKey): Promise<{ verdict: string; key: EvidenceKey } | null> {
  const url = `${BASE_URL}/api/sourcing/verdicts/recompute`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      recordType: key.recordType,
      recordId: key.recordId,
      fieldName: key.fieldName,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      `recompute failed: ${res.status} ${res.statusText} for ${key.recordType}/${key.recordId}/${key.fieldName ?? "null"} — ${text.slice(0, 200)}`,
    );
    return null;
  }
  const data = (await res.json()) as { verdict: string };
  return { verdict: data.verdict, key };
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

async function main(): Promise<void> {
  console.log(`Wiki-server: ${BASE_URL}`);
  console.log(`Mode: ${APPLY ? "APPLY (will write)" : "DRY RUN (samples 5 keys)"}`);
  if (LIMIT) console.log(`Limit: ${LIMIT}`);
  console.log("");

  console.log("Fetching baseline verdict distribution...");
  const before = await fetchVerdictDistribution();
  console.log("Baseline:");
  for (const { verdict, count } of before) {
    console.log(`  ${verdict.padEnd(15)} ${count}`);
  }
  console.log("");

  console.log("Listing keys to recompute...");
  const keys = await listKeys();
  console.log(`  ${keys.length} keys`);
  console.log("");

  if (!APPLY) {
    console.log("DRY RUN — sampling 5 keys:");
    for (const key of keys.slice(0, 5)) {
      const r = await recompute(key);
      if (r) {
        console.log(`  ${key.recordType}/${key.recordId}/${key.fieldName ?? "null"} → ${r.verdict}`);
      }
    }
    console.log("\nRe-run with --apply to recompute all keys.");
    return;
  }

  console.log(`Recomputing ${keys.length} keys with concurrency=${CONCURRENCY}...`);
  const t0 = Date.now();
  const results = await runWithConcurrency(keys, CONCURRENCY, recompute);
  const elapsedSec = Math.round((Date.now() - t0) / 1000);
  const ok = results.filter((r) => r !== null).length;
  const failed = results.length - ok;
  console.log(`  ${ok} succeeded, ${failed} failed in ${elapsedSec}s`);
  console.log("");

  console.log("Fetching post-recompute verdict distribution...");
  const after = await fetchVerdictDistribution();
  console.log("After:");
  for (const { verdict, count } of after) {
    console.log(`  ${verdict.padEnd(15)} ${count}`);
  }

  console.log("\nDiff (after - before):");
  const verdicts = new Set([
    ...before.map((r) => r.verdict),
    ...after.map((r) => r.verdict),
  ]);
  for (const v of verdicts) {
    const beforeCount = before.find((r) => r.verdict === v)?.count ?? 0;
    const afterCount = after.find((r) => r.verdict === v)?.count ?? 0;
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
