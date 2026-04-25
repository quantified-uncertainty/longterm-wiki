/**
 * Shared constants and helpers used across benchmark-related sync routes.
 *
 * QUA-689 — extracted to keep the `benchmark_results.tested_by` enum and
 * the slug→id resolution flow in one place. Three routes need this:
 *   - benchmarks.ts            (validates `category`, no tested_by)
 *   - benchmark-results.ts     (validates `tested_by`, resolves benchmark slugs)
 *   - benchmark-results-pending.ts (same)
 *
 * The migration `0207_qua_689_safety_benchmark_foundation.sql` defines the
 * authoritative CHECK constraints (`chk_br_tested_by`, `chk_brp_tested_by`).
 * Adding a value here without updating the migration will pass schema
 * validation in TS and then fail at upsert time.
 */

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../schema.js";
import { validationError } from "../shared/utils.js";
import { sqlInList } from "../shared/query-helpers.js";

type Db = PostgresJsDatabase<typeof schema>;

/** Allowed values for `benchmark_results.tested_by` and `benchmark_results_pending.tested_by`. */
export const VALID_TESTED_BY = [
  "self-report",
  "leaderboard",
  "aisi-uk",
  "aisi-us",
  "metr",
  "apollo",
  "third-party-paper",
  "epoch-ai",
  "unknown",
] as const;

export type TestedBy = (typeof VALID_TESTED_BY)[number];

/**
 * Validate that every `benchmarkId` in `items` exists in the benchmarks table
 * (matching by either canonical id or slug), and rewrite slugs in-place to
 * canonical ids so downstream upserts use the right FK.
 *
 * Returns null on success. On a missing reference, returns a 400 Response
 * via `validationError(c, ...)`.
 *
 * Mutates `items` — same shape as the existing benchmark-results.ts
 * preValidate hook used to expose, now extracted so benchmark-results-pending
 * can reuse it without copy-paste drift.
 */
export async function resolveBenchmarkRefs<
  T extends { benchmarkId: string },
>(
  c: Context,
  db: Db,
  items: T[],
): Promise<Response | null> {
  const benchmarkIds = [...new Set(items.map((i) => i.benchmarkId))];
  if (benchmarkIds.length === 0) return null;
  const found = await db.execute<{ id: string; slug: string }>(sql`
    SELECT id, slug FROM benchmarks WHERE id IN (${sqlInList(benchmarkIds)}) OR slug IN (${sqlInList(benchmarkIds)})
  `);
  const foundIdSet = new Set(found.map((r) => r.id));
  const foundSlugSet = new Set(found.map((r) => r.slug));
  const slugToId = new Map(found.map((r) => [r.slug, r.id]));
  const missing = benchmarkIds.filter(
    (id) => !foundIdSet.has(id) && !foundSlugSet.has(id),
  );
  if (missing.length > 0) {
    return validationError(
      c,
      `Benchmark references not found in benchmarks table: ${missing.join(", ")}. Ensure benchmarks are synced first.`,
    );
  }
  for (const item of items) {
    const canonical = slugToId.get(item.benchmarkId);
    if (canonical) item.benchmarkId = canonical;
  }
  return null;
}
