/**
 * System Card → benchmark_results linker (QUA-702).
 *
 * Reads `eval_scores_cited` from a freshly-upserted batch of
 * `model_system_cards` rows and:
 *
 *  1. Fuzzy-matches each cited benchmark name against `benchmarks.name`
 *     and `benchmarks.slug`.
 *  2. For matches: upserts a row into `benchmark_results` with
 *     `tested_by='self-report'` and `source_url` pointing at the system
 *     card. Self-reports never overwrite rows whose `tested_by` is
 *     `'third-party'`. Rows with `tested_by IS NULL AND source_url IS NULL`
 *     (empty legacy stubs that no one ever filled) are treated as fillable
 *     and may be replaced by a self-report — but a NULL `tested_by` with a
 *     `source_url` is still protected (someone curated it from another
 *     source and forgot to set `tested_by`).
 *  3. For non-matches: enqueues a row in `pending_benchmark_links` for
 *     human/follow-up resolution. Idempotent on re-extract via the
 *     `(model_system_card_id, cited_name)` unique index.
 *
 * Idempotent on re-extract: re-running on the same card re-resolves all
 * cited names, refreshes existing self-report rows, refreshes pending
 * queue rows, and never creates duplicates.
 */

import { sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { generateId } from "@longterm-wiki/factbase";
import * as schema from "../../schema.js";
import { benchmarks, benchmarkResults, pendingBenchmarkLinks } from "../../schema.js";

type Tx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

// ── Public types ────────────────────────────────────────────────────────

export interface CitedScore {
  benchmark: string; // free-form name as cited in the card
  score?: number | null;
  metric?: string | null;
  setup?: string | null;
  excerpt?: string | null;
}

export interface SystemCardForLinking {
  id: string;                  // model_system_cards.id
  aiModelId: string;            // entities.stable_id
  sourceUrl: string;
  releaseDate?: string | null;  // YYYY-MM-DD
  evalScoresCited?: CitedScore[] | null;
}

export interface LinkResult {
  matched: number;            // # of cited entries linked into benchmark_results
  queued: number;             // # of cited entries queued in pending_benchmark_links
  skipped: number;            // # of cited entries skipped (no name, etc.)
  protectedSkips: number;     // # of cited entries that matched but had a non-self-report row already
}

interface BenchmarkLookup {
  byNormalized: Map<string, { id: string; name: string }>;
}

// ── Normalization ───────────────────────────────────────────────────────

/**
 * Normalize a benchmark name for fuzzy matching. Strategy:
 *   - lowercase
 *   - strip non-alphanumeric (so "MMLU-Pro" → "mmlupro", "GPQA Diamond" → "gpqadiamond")
 *
 * This is intentionally aggressive — it will match "SWE-bench Verified"
 * to "swebenchverified" — but it errs on the side of recall. Borderline
 * matches end up in the queue, where a human can confirm or reject.
 *
 * Exported for tests.
 */
export function normalizeBenchmarkName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ── Lookup table builder ────────────────────────────────────────────────

/**
 * Build an in-memory normalized lookup for the entire benchmarks table.
 * Loaded once per sync batch; system cards typically cite 5–30
 * benchmarks each, so the up-front cost is amortized across the batch.
 */
async function loadBenchmarkLookup(tx: Tx): Promise<BenchmarkLookup> {
  const rows = await tx.select({
    id: benchmarks.id,
    slug: benchmarks.slug,
    name: benchmarks.name,
  }).from(benchmarks);

  const byNormalized = new Map<string, { id: string; name: string }>();
  for (const r of rows) {
    // Index by both name and slug. If two benchmarks normalize to the
    // same key, the first one wins — this should be exceedingly rare and
    // the human review of the queue will catch it.
    const nameKey = normalizeBenchmarkName(r.name);
    const slugKey = normalizeBenchmarkName(r.slug);
    if (!byNormalized.has(nameKey)) {
      byNormalized.set(nameKey, { id: r.id, name: r.name });
    }
    if (!byNormalized.has(slugKey)) {
      byNormalized.set(slugKey, { id: r.id, name: r.name });
    }
  }

  return { byNormalized };
}

function resolveCitedName(
  lookup: BenchmarkLookup,
  citedName: string,
): { id: string; name: string } | null {
  const key = normalizeBenchmarkName(citedName);
  if (key === "") return null;
  return lookup.byNormalized.get(key) ?? null;
}

// ── Per-card linking ────────────────────────────────────────────────────

/**
 * Process one card, dispatching each cited benchmark into either
 * benchmark_results (matched) or pending_benchmark_links (queued).
 *
 * Note on idempotency: this function is called inside the same
 * transaction that just upserted `card`, so re-running is safe — both
 * downstream tables have natural-key uniqueness:
 *   - benchmark_results: (benchmarkId, modelId) unique
 *   - pending_benchmark_links: (modelSystemCardId, citedName) unique
 *
 * Note on protection: the benchmark_results upsert uses a WHERE clause
 * `WHERE benchmark_results.tested_by = 'self-report'` on conflict — so a
 * NULL or 'third-party' row is preserved untouched. The factory normally
 * does this with a `conflictSet`; we use raw SQL here because Drizzle's
 * onConflict doesn't expose a per-update WHERE clause cleanly.
 */
async function linkOneCard(
  tx: Tx,
  card: SystemCardForLinking,
  lookup: BenchmarkLookup,
): Promise<LinkResult> {
  const result: LinkResult = {
    matched: 0,
    queued: 0,
    skipped: 0,
    protectedSkips: 0,
  };

  const cites = card.evalScoresCited ?? [];
  if (cites.length === 0) return result;

  const now = new Date();

  for (const cite of cites) {
    const name = (cite.benchmark ?? "").trim();
    if (name === "") {
      result.skipped += 1;
      continue;
    }

    const match = resolveCitedName(lookup, name);

    if (match) {
      // Insert into benchmark_results, but only update the row if it's
      // already a self-report. This is the "self-reports never overwrite
      // third-party" rule from the QUA-702 acceptance criteria.
      //
      // Note: score is required by the schema; if the cited score is
      // missing we still want to record provenance, so we use 0 as a
      // sentinel matching the convention in crux/commands/system-cards.ts
      // and rely on `tested_by='self-report'` + `notes` for context.
      const score = cite.score ?? 0;
      const id = generateId().replace(/^sid_/, "").slice(0, 10);
      const note = [cite.metric, cite.setup].filter(Boolean).join(" · ");

      // Drizzle doesn't expose a WHERE clause on ON CONFLICT DO UPDATE
      // cleanly; build the SQL by hand. The unique index on
      // (benchmark_id, model_id) is the conflict target.
      //
      // Postgres returns 0 rows from RETURNING when the WHERE clause
      // filters out the conflict row, so a 0-length result means "matched
      // a row we shouldn't touch" (i.e., third-party data is protected).
      const insertResult = await tx.execute<{ tested_by: string | null }>(sql`
        INSERT INTO benchmark_results (
          id, benchmark_id, model_id, score, unit, date,
          source_url, notes, tested_by,
          synced_at, created_at, updated_at
        )
        VALUES (
          ${id}, ${match.id}, ${card.aiModelId}, ${score},
          ${cite.metric ?? null}, ${card.releaseDate ?? null},
          ${card.sourceUrl}, ${note || null}, 'self-report',
          ${now}, ${now}, ${now}
        )
        ON CONFLICT (benchmark_id, model_id)
        DO UPDATE SET
          score = EXCLUDED.score,
          unit = COALESCE(EXCLUDED.unit, benchmark_results.unit),
          date = COALESCE(EXCLUDED.date, benchmark_results.date),
          source_url = EXCLUDED.source_url,
          notes = EXCLUDED.notes,
          tested_by = 'self-report',
          synced_at = EXCLUDED.synced_at,
          updated_at = EXCLUDED.updated_at
        WHERE benchmark_results.tested_by = 'self-report'
           OR (benchmark_results.tested_by IS NULL AND benchmark_results.source_url IS NULL)
        RETURNING tested_by
      `);

      if (insertResult.length > 0) {
        result.matched += 1;
      } else {
        result.protectedSkips += 1;
      }
    } else {
      // Queue for human review.
      const id = generateId().replace(/^sid_/, "").slice(0, 10);
      const queueResult = await tx.execute<{ id: string }>(sql`
        INSERT INTO pending_benchmark_links (
          id, model_system_card_id, ai_model_id, cited_name,
          cited_score, cited_metric, cited_setup, cited_excerpt,
          status, synced_at, created_at, updated_at
        )
        VALUES (
          ${id}, ${card.id}, ${card.aiModelId}, ${name},
          ${cite.score ?? null}, ${cite.metric ?? null}, ${cite.setup ?? null},
          ${cite.excerpt ?? null}, 'pending', ${now}, ${now}, ${now}
        )
        ON CONFLICT (model_system_card_id, cited_name_normalized)
        DO UPDATE SET
          cited_score = EXCLUDED.cited_score,
          cited_metric = EXCLUDED.cited_metric,
          cited_setup = EXCLUDED.cited_setup,
          cited_excerpt = EXCLUDED.cited_excerpt,
          synced_at = EXCLUDED.synced_at,
          updated_at = EXCLUDED.updated_at
        WHERE pending_benchmark_links.status = 'pending'
        RETURNING id
      `);
      // RETURNING id is empty when the WHERE clause filtered out the
      // conflict row — i.e., the existing queue entry is already resolved
      // or rejected. Counting it as queued would over-report queue activity.
      if (queueResult.length > 0) {
        result.queued += 1;
      } else {
        result.protectedSkips += 1;
      }
    }
  }

  return result;
}

// ── Entry point ─────────────────────────────────────────────────────────

/**
 * Link cited benchmarks for a batch of system cards. Called from the
 * model-system-cards postUpsert hook inside the sync transaction.
 *
 * Returns an aggregated LinkResult summing across all cards.
 */
export async function linkSystemCardBenchmarks(
  tx: Tx,
  cards: SystemCardForLinking[],
): Promise<LinkResult> {
  const total: LinkResult = {
    matched: 0,
    queued: 0,
    skipped: 0,
    protectedSkips: 0,
  };

  // Skip the lookup load if no cards have any cited evals.
  const hasAnyCites = cards.some(
    (c) => Array.isArray(c.evalScoresCited) && c.evalScoresCited.length > 0,
  );
  if (!hasAnyCites) return total;

  const lookup = await loadBenchmarkLookup(tx);

  for (const card of cards) {
    const r = await linkOneCard(tx, card, lookup);
    total.matched += r.matched;
    total.queued += r.queued;
    total.skipped += r.skipped;
    total.protectedSkips += r.protectedSkips;
  }

  return total;
}

// Exported for tests so the suite doesn't have to mock the whole tx surface.
export { loadBenchmarkLookup, linkOneCard };

// Suppress "unused" warning for pendingBenchmarkLinks/benchmarkResults imports
// at module load time — they're referenced by the typed schema in the inserts
// above (via the table names).
void pendingBenchmarkLinks;
void benchmarkResults;
