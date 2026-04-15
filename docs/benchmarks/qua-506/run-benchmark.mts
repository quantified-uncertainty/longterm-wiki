/* eslint-disable no-console */
/**
 * QUA-506 Phase 4b-B.2b D1 benchmark runner — 20-table UNION ALL composed shape.
 *
 * Closes the "refresh cost on composed shape" measurement gap from QUA-476
 * (Phase 2a). The 2a benchmark measured refresh time against a self-SELECT
 * from `things`, which had only 6% parent_thing_id coverage and therefore
 * undercounted JOIN cost by ~15×. This runner rebuilds the MV via UNION ALL
 * across 20+ source tables, LEFT JOINing `entities` on every branch that
 * resolves a parent title, so refresh cost exercises 100% of the JOIN work
 * the real 2b migration will do.
 *
 * Safety model: read-only + TEMP-table only for the default Phase A run. No
 * persistent DDL, no writes. The SELECT from `docs/benchmarks/qua-506/things-search-mv-2b.sql`
 * is wrapped as `CREATE TEMP TABLE things_search_bench_2b AS (<inner select>)`.
 * TEMP objects are dropped automatically when the client disconnects.
 *
 * Phase B (persistent MV for CONCURRENTLY + concurrent-reader tests) is gated
 * behind `--phase-b` and requires explicit coordinator approval — a persistent
 * MV on prod uses storage and affects the autovacuum / pg_stat pipelines. Do
 * not run with `--phase-b` without approval in the ticket comment thread.
 *
 * Abort thresholds (from QUA-506 scope):
 *   - Cold refresh (non-concurrent) > 60 s → ABORT
 *   - REFRESH CONCURRENTLY > 90 s → ABORT
 *   - Concurrent-reader p95 during refresh > 2× steady-state → ABORT
 *   - Any blocking behavior on concurrent readers → ABORT
 *
 * Usage:
 *   PRODUCTION_DB_URL=... node --import tsx/esm docs/benchmarks/qua-506/run-benchmark.mts \
 *     > docs/benchmarks/qua-506/benchmark-results.json \
 *     2> docs/benchmarks/qua-506/benchmark-stderr.log
 *
 *   # With persistent MV (needs approval):
 *   PRODUCTION_DB_URL=... node --import tsx/esm docs/benchmarks/qua-506/run-benchmark.mts \
 *     --phase-b > docs/benchmarks/qua-506/benchmark-results-phase-b.json
 */

import postgres from "../../../apps/wiki-server/node_modules/postgres/cjs/src/index.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadDotenv() {
  const p = resolve(process.cwd(), ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^"|"$/g, "");
  }
}
loadDotenv();

const dbUrl = process.env.PRODUCTION_DB_URL;
if (!dbUrl) {
  console.error("PRODUCTION_DB_URL not set");
  process.exit(1);
}

const ARGS = new Set(process.argv.slice(2));
const PHASE_B = ARGS.has("--phase-b");
const SKIP_REFRESH_CONCURRENT_READERS = ARGS.has("--skip-concurrent-readers");

const dbHostPort = (() => {
  try {
    const u = new URL(dbUrl);
    return `${u.hostname}:${u.port || "5432"}`;
  } catch {
    return "<unparseable>";
  }
})();

// The single-connection pool we use for everything in Phase A and the
// refresh orchestration in Phase B.
function mkPool(appName: string, max = 1) {
  return postgres(dbUrl!, {
    ssl: "require",
    max,
    idle_timeout: 20,
    connection: { application_name: appName },
    // Redirect Postgres NOTICEs to stderr so they don't pollute stdout
    // (stdout is the JSON results stream).
    onnotice: (notice: { message?: string }) => {
      if (notice?.message) console.error(`  [pg NOTICE] ${notice.message}`);
    },
  });
}

const sql = mkPool("qua-506-benchmark");

async function time(label: string, fn: () => Promise<unknown>): Promise<number> {
  const start = process.hrtime.bigint();
  await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.error(`  [${ms.toFixed(1)}ms] ${label}`);
  return ms;
}

function toTsquery(q: string): string {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/gi, ""))
    .filter(Boolean)
    .map((t) => `${t}:*`)
    .join(" & ");
}

interface BenchStat {
  label: string;
  n: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  samples: number[];
}

async function bench<T>(
  label: string,
  n: number,
  fn: () => Promise<T>,
  quiet = false,
): Promise<BenchStat> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const pick = (p: number) => samples[Math.round(p * (samples.length - 1))];
  const stat: BenchStat = {
    label,
    n,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    min: samples[0],
    max: samples[samples.length - 1],
    samples,
  };
  if (!quiet) {
    console.error(
      `  [${label}] n=${n} p50=${stat.p50.toFixed(1)} p95=${stat.p95.toFixed(1)} p99=${stat.p99.toFixed(1)}`,
    );
  }
  return stat;
}

/**
 * Load the candidate SQL file and extract the inner SELECT statement.
 *
 * The .sql file uses `CREATE MATERIALIZED VIEW things_search_bench_2b AS
 * SELECT ... FROM (<UNION ALL>) AS base WITH NO DATA;` — we need just the
 * `SELECT ... FROM (<UNION ALL>) AS base` portion so we can wrap it with
 * different CREATE statements (TEMP TABLE for Phase A, MATERIALIZED VIEW for
 * Phase B).
 */
function loadInnerSelect(): string {
  const path = resolve(__dirname, "things-search-mv-2b.sql");
  const raw = readFileSync(path, "utf8");
  const start = raw.indexOf("CREATE MATERIALIZED VIEW IF NOT EXISTS things_search_bench_2b AS");
  if (start < 0) throw new Error("Could not find CREATE MATERIALIZED VIEW in SQL file");
  // Start of SELECT is right after the CREATE line.
  const afterCreate = raw.indexOf("\n", start) + 1;
  const withNoData = raw.indexOf(") AS base\nWITH NO DATA;", afterCreate);
  if (withNoData < 0) throw new Error("Could not find WITH NO DATA terminator in SQL file");
  // Include the closing `) AS base`, exclude `WITH NO DATA;`.
  return raw.slice(afterCreate, withNoData + ") AS base".length).trim();
}

const INNER_SELECT = loadInnerSelect();

const QUERIES = [
  "anthropic",
  "openai",
  "safety",
  "governance",
  "deepmind",
  "evaluation benchmark",
  "sb 1047",
  "alignment research",
  "grant recipient",
  "nonexistentxyzqueryqwerty",
];
const PER_QUERY_SAMPLES = 15;

async function benchFtsOn(
  table: string,
  variant: string,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const q of QUERIES) {
    const tsquery = toTsquery(q);
    if (!tsquery) continue;
    const stat = await bench(`${variant}: "${q}"`, PER_QUERY_SAMPLES, async () => {
      await sql.unsafe(
        `SELECT t.id, t.title, ts_rank(t.search_vector, to_tsquery('english', $1)) AS rank
         FROM ${table} t
         WHERE t.search_vector @@ to_tsquery('english', $1)
         ORDER BY rank DESC
         LIMIT 20`,
        [tsquery],
      );
    });
    out.push({ query: q, tsquery, ...stat });
  }
  return out;
}

const results: Record<string, unknown> = {
  generated_at: new Date().toISOString(),
  phase: PHASE_B ? "A+B" : "A",
  safety:
    PHASE_B
      ? "PERSISTENT MV — requires coordinator approval. Creates things_search_bench_2b MV on prod, drops at end."
      : "TEMP-TABLE only; no persistent DDL; no writes; application_name=qua-506-benchmark",
  abort_thresholds: {
    cold_refresh_ms: 60_000,
    concurrent_refresh_ms: 90_000,
    concurrent_reader_p95_multiplier: 2.0,
  },
};

let aborted = false;
const abortReasons: string[] = [];

function checkAbort(label: string, valueMs: number, thresholdMs: number) {
  if (valueMs > thresholdMs) {
    const msg = `${label}: ${valueMs.toFixed(0)}ms > ${thresholdMs}ms threshold`;
    console.error(`\n✗ ABORT — ${msg}`);
    abortReasons.push(msg);
    aborted = true;
  }
}

async function setSessionParams() {
  await sql`SET application_name = 'qua-506-benchmark'`;
  await sql`SET statement_timeout = '300s'`; // give enough room for big UNION ALL
  await sql`SET maintenance_work_mem = '256MB'`;
  await sql`SET work_mem = '64MB'`;
}

async function phaseA() {
  console.error("\n=== PHASE A: TEMP TABLE (no persistent DDL) ===");

  // --- 0. Baseline ---
  console.error("\n--- 0. Baseline: things table size and row count ---");
  const stats = await sql`
    SELECT
      (SELECT COUNT(*) FROM things)::bigint AS row_count,
      pg_total_relation_size('things')::bigint AS total_bytes,
      pg_relation_size('things')::bigint AS heap_bytes,
      pg_indexes_size('things')::bigint AS index_bytes,
      (SELECT pg_relation_size('idx_things_search'))::bigint AS gin_bytes
  `;
  results.baseline_stats = stats[0];
  console.error("  ", stats[0]);

  const typeBreakdown = await sql`
    SELECT thing_type, COUNT(*)::bigint AS n
    FROM things
    GROUP BY thing_type
    ORDER BY n DESC
  `;
  results.type_breakdown = typeBreakdown;

  // --- 1. Baseline /search query latency (current things.search_vector) ---
  console.error("\n--- 1. Baseline /search queries (current things.search_vector) ---");
  results.baseline_queries = await benchFtsOn("things", "baseline");

  // --- 2. TEMP TABLE build — 3 runs of the 20-table UNION ALL composed shape ---
  console.error("\n--- 2. TEMP TABLE build (composed UNION ALL, 3 runs) ---");
  const buildRuns = 3;
  const buildTimings: number[] = [];
  const pkTimings: number[] = [];
  const ginTimings: number[] = [];
  const secondaryTimings: number[] = [];
  const totalTimings: number[] = [];

  for (let run = 1; run <= buildRuns; run++) {
    console.error(`  --- run ${run}/${buildRuns} ---`);
    await sql`DROP TABLE IF EXISTS things_search_bench_2b`;

    const createMs = await time(`run ${run}: CREATE TEMP TABLE AS SELECT (UNION ALL)`, () =>
      sql.unsafe(`CREATE TEMP TABLE things_search_bench_2b AS ${INNER_SELECT}`),
    );
    buildTimings.push(createMs);

    const pkMs = await time(`run ${run}: CREATE UNIQUE INDEX pkey`, () =>
      sql.unsafe(
        `CREATE UNIQUE INDEX things_search_bench_2b_pkey ON things_search_bench_2b (id)`,
      ),
    );
    pkTimings.push(pkMs);

    const ginMs = await time(`run ${run}: CREATE GIN INDEX search_vector`, () =>
      sql.unsafe(
        `CREATE INDEX things_search_bench_2b_gin ON things_search_bench_2b USING GIN (search_vector)`,
      ),
    );
    ginTimings.push(ginMs);

    // Secondary indexes (measured as one group because they're small).
    const secStart = process.hrtime.bigint();
    await sql.unsafe(
      `CREATE INDEX things_search_bench_2b_type_idx ON things_search_bench_2b (thing_type)`,
    );
    await sql.unsafe(
      `CREATE INDEX things_search_bench_2b_parent_idx ON things_search_bench_2b (parent_thing_id)`,
    );
    await sql.unsafe(
      `CREATE INDEX things_search_bench_2b_entity_type_idx ON things_search_bench_2b (entity_type)`,
    );
    await sql.unsafe(
      `CREATE INDEX things_search_bench_2b_updated_idx ON things_search_bench_2b (updated_at)`,
    );
    const secMs = Number(process.hrtime.bigint() - secStart) / 1e6;
    console.error(`  [${secMs.toFixed(1)}ms] run ${run}: CREATE 4 secondary btree indexes`);
    secondaryTimings.push(secMs);

    totalTimings.push(createMs + pkMs + ginMs + secMs);

    // Size of the constructed object.
    const sizes = await sql`
      SELECT
        pg_total_relation_size('pg_temp.things_search_bench_2b'::regclass)::bigint AS total_bytes,
        pg_relation_size('pg_temp.things_search_bench_2b'::regclass)::bigint AS heap_bytes,
        pg_indexes_size('pg_temp.things_search_bench_2b'::regclass)::bigint AS index_bytes,
        (SELECT COUNT(*) FROM things_search_bench_2b)::bigint AS row_count
    `;
    if (run === buildRuns) results.temp_build_sizes = sizes[0];

    await sql.unsafe(`ANALYZE things_search_bench_2b`);
  }

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const avg = (xs: number[]) => sum(xs) / xs.length;

  results.cold_refresh = {
    create_ms: buildTimings,
    pk_index_ms: pkTimings,
    gin_index_ms: ginTimings,
    secondary_index_ms: secondaryTimings,
    total_ms: totalTimings,
    create_avg_ms: avg(buildTimings),
    total_avg_ms: avg(totalTimings),
    total_max_ms: Math.max(...totalTimings),
  };

  console.error(
    `\n  cold refresh total: avg=${avg(totalTimings).toFixed(0)}ms max=${Math.max(...totalTimings).toFixed(0)}ms (threshold 60000ms)`,
  );
  checkAbort("Cold refresh (max)", Math.max(...totalTimings), 60_000);

  // --- 3. MV query latency (against the TEMP TABLE with full GIN + ANALYZE) ---
  console.error("\n--- 3. MV query latency (TEMP TABLE stand-in) ---");
  results.mv_queries = await benchFtsOn("things_search_bench_2b", "mv");

  // Keep the TEMP table around for the /list and /children probes below.
}

/**
 * D5 — verify /api/things/list, /api/things/children, /api/things/:id latency
 * against the MV-shaped TEMP table vs the current `things` table. Just a
 * sanity check that the secondary btrees are doing what we expect.
 */
async function phaseADSFive() {
  console.error("\n--- 4. D5 endpoint spot-checks (/list, /children, /:id) ---");

  // Sample IDs to probe.
  const sample = await sql`
    SELECT id, parent_thing_id, thing_type
    FROM things
    WHERE parent_thing_id IS NOT NULL
    LIMIT 5
  `;
  const sampleIds = sample.map((r) => r.id as string);

  const d5Results: Record<string, unknown> = {};

  // /list — paginated
  d5Results.list_baseline = await bench("baseline: /list (limit 50 offset 0)", 10, () =>
    sql`SELECT * FROM things ORDER BY updated_at DESC LIMIT 50 OFFSET 0`,
  );
  d5Results.list_mv = await bench("mv: /list (limit 50 offset 0)", 10, () =>
    sql`SELECT * FROM things_search_bench_2b ORDER BY updated_at DESC LIMIT 50 OFFSET 0`,
  );

  // /:id — single row
  if (sampleIds[0]) {
    d5Results.byid_baseline = await bench("baseline: /:id", 10, () =>
      sql`SELECT * FROM things WHERE id = ${sampleIds[0]}`,
    );
    d5Results.byid_mv = await bench("mv: /:id", 10, () =>
      sql`SELECT * FROM things_search_bench_2b WHERE id = ${sampleIds[0]}`,
    );
  }

  // /children — by parent_thing_id
  const parentIds = sample
    .map((r) => r.parent_thing_id as string | null)
    .filter((x): x is string => !!x);
  if (parentIds[0]) {
    d5Results.children_baseline = await bench("baseline: /children", 10, () =>
      sql`SELECT * FROM things WHERE parent_thing_id = ${parentIds[0]}`,
    );
    d5Results.children_mv = await bench("mv: /children", 10, () =>
      sql`SELECT * FROM things_search_bench_2b WHERE parent_thing_id = ${parentIds[0]}`,
    );
  }

  // /list filtered by thing_type
  d5Results.by_type_baseline = await bench("baseline: /list?thing_type=entity", 10, () =>
    sql`SELECT * FROM things WHERE thing_type = 'entity' ORDER BY updated_at DESC LIMIT 50`,
  );
  d5Results.by_type_mv = await bench("mv: /list?thing_type=entity", 10, () =>
    sql`SELECT * FROM things_search_bench_2b WHERE thing_type = 'entity' ORDER BY updated_at DESC LIMIT 50`,
  );

  results.d5_queries = d5Results;
}

/**
 * Phase B — persistent MV for REFRESH CONCURRENTLY + concurrent-reader testing.
 * Guarded behind --phase-b. Creates `things_search_bench_2b` as a persistent
 * MATERIALIZED VIEW on prod, runs the tests, drops the MV at the end.
 */
async function phaseB() {
  console.error("\n=== PHASE B: PERSISTENT MV (requires coordinator approval) ===");
  console.error("  Creating persistent MATERIALIZED VIEW things_search_bench_2b on prod...");

  // Phase A leaves a TEMP TABLE of the same name alive in this session. Drop
  // it first so CREATE MATERIALIZED VIEW can reuse the name. DROP TABLE IF
  // EXISTS won't error when the table doesn't exist.
  await sql.unsafe(`DROP TABLE IF EXISTS things_search_bench_2b`);
  // Also drop any stale persistent MV from a prior aborted run.
  await sql.unsafe(`DROP MATERIALIZED VIEW IF EXISTS things_search_bench_2b`);

  // --- 1. CREATE MATERIALIZED VIEW ... WITH NO DATA ---
  const createMvMs = await time("CREATE MATERIALIZED VIEW ... WITH NO DATA", () =>
    sql.unsafe(
      `CREATE MATERIALIZED VIEW things_search_bench_2b AS ${INNER_SELECT} WITH NO DATA`,
    ),
  );

  // --- 2. Initial non-concurrent populated refresh (required — CONCURRENTLY cannot work on unpopulated MV) ---
  const initialRefreshMs = await time("REFRESH MATERIALIZED VIEW (initial, non-concurrent)", () =>
    sql.unsafe(`REFRESH MATERIALIZED VIEW things_search_bench_2b`),
  );

  // --- 3. Create indexes (UNIQUE on id is REQUIRED for CONCURRENTLY refresh) ---
  const pkMs = await time("CREATE UNIQUE INDEX pkey", () =>
    sql.unsafe(
      `CREATE UNIQUE INDEX things_search_bench_2b_pkey ON things_search_bench_2b (id)`,
    ),
  );
  const ginMs = await time("CREATE GIN INDEX search_vector", () =>
    sql.unsafe(
      `CREATE INDEX things_search_bench_2b_gin ON things_search_bench_2b USING GIN (search_vector)`,
    ),
  );
  const secStart = process.hrtime.bigint();
  await sql.unsafe(
    `CREATE INDEX things_search_bench_2b_type_idx ON things_search_bench_2b (thing_type)`,
  );
  await sql.unsafe(
    `CREATE INDEX things_search_bench_2b_parent_idx ON things_search_bench_2b (parent_thing_id)`,
  );
  await sql.unsafe(
    `CREATE INDEX things_search_bench_2b_entity_type_idx ON things_search_bench_2b (entity_type)`,
  );
  await sql.unsafe(
    `CREATE INDEX things_search_bench_2b_updated_idx ON things_search_bench_2b (updated_at)`,
  );
  const secMs = Number(process.hrtime.bigint() - secStart) / 1e6;
  console.error(`  [${secMs.toFixed(1)}ms] CREATE 4 secondary btree indexes`);

  await sql.unsafe(`ANALYZE things_search_bench_2b`);

  // --- 4. REFRESH MATERIALIZED VIEW (non-concurrent, 3 runs after populate) ---
  console.error("\n--- REFRESH MATERIALIZED VIEW (non-concurrent, 3 runs) ---");
  const refreshNonConcurrent: number[] = [];
  for (let run = 1; run <= 3; run++) {
    refreshNonConcurrent.push(
      await time(`run ${run}: REFRESH MV (non-concurrent)`, () =>
        sql.unsafe(`REFRESH MATERIALIZED VIEW things_search_bench_2b`),
      ),
    );
  }

  // --- 5. REFRESH MATERIALIZED VIEW CONCURRENTLY (3 runs) ---
  console.error("\n--- REFRESH MATERIALIZED VIEW CONCURRENTLY (3 runs) ---");
  const refreshConcurrent: number[] = [];
  for (let run = 1; run <= 3; run++) {
    refreshConcurrent.push(
      await time(`run ${run}: REFRESH MV CONCURRENTLY`, () =>
        sql.unsafe(`REFRESH MATERIALIZED VIEW CONCURRENTLY things_search_bench_2b`),
      ),
    );
  }

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const avg = (xs: number[]) => sum(xs) / xs.length;
  const refreshConcurrentMax = Math.max(...refreshConcurrent);

  console.error(
    `\n  REFRESH CONCURRENTLY: avg=${avg(refreshConcurrent).toFixed(0)}ms max=${refreshConcurrentMax.toFixed(0)}ms (threshold 90000ms)`,
  );
  checkAbort("CONCURRENTLY refresh (max)", refreshConcurrentMax, 90_000);

  // --- 6. Concurrent-reader latency during CONCURRENTLY refresh ---
  // Baseline steady-state first, then refresh+50-concurrent queries.
  if (!SKIP_REFRESH_CONCURRENT_READERS) {
    console.error("\n--- Concurrent-reader latency: steady-state vs during-refresh ---");

    // Shared pool sized like wiki-server's real connection pool (max=10).
    // 50 concurrent queries fire through it via Promise.all — 10 run in
    // parallel, 40 queue. This matches the production traffic shape better
    // than opening 50 separate connections (which hit DO managed postgres's
    // per-db connection ceiling and failed the first run).
    const readerPool = mkPool("qua-506-readers", 10);
    const concurrentReaderTest = async (label: string): Promise<BenchStat> => {
      // Scope: "fire 50 concurrent /search queries while refresh runs".
      const totalQueries = 50;
      const samples: number[] = [];
      const fireOne = async (idx: number): Promise<void> => {
        const q = QUERIES[idx % QUERIES.length];
        const tsquery = toTsquery(q);
        if (!tsquery) return;
        const start = process.hrtime.bigint();
        await readerPool.unsafe(
          `SELECT t.id, t.title, ts_rank(t.search_vector, to_tsquery('english', $1)) AS rank
           FROM things_search_bench_2b t
           WHERE t.search_vector @@ to_tsquery('english', $1)
           ORDER BY rank DESC LIMIT 20`,
          [tsquery],
        );
        samples.push(Number(process.hrtime.bigint() - start) / 1e6);
      };
      const promises: Promise<void>[] = [];
      for (let i = 0; i < totalQueries; i++) promises.push(fireOne(i));
      await Promise.all(promises);
      samples.sort((a, b) => a - b);
      const pick = (p: number) => samples[Math.round(p * (samples.length - 1))];
      const stat: BenchStat = {
        label,
        n: samples.length,
        p50: pick(0.5),
        p95: pick(0.95),
        p99: pick(0.99),
        min: samples[0],
        max: samples[samples.length - 1],
        samples,
      };
      console.error(
        `  [${label}] n=${stat.n} p50=${stat.p50.toFixed(1)} p95=${stat.p95.toFixed(1)} p99=${stat.p99.toFixed(1)}`,
      );
      return stat;
    };

    // Steady state
    const steady = await concurrentReaderTest("steady-state reads");

    // During refresh — kick off refresh and readers concurrently. Use a
    // separate pool for the refresh so it doesn't contend with the reader
    // pool's connections.
    console.error("  Kicking off refresh + 50 concurrent /search queries...");
    const refreshPool = mkPool("qua-506-bench-refresh", 1);
    const refreshStart = process.hrtime.bigint();
    const refreshPromise = refreshPool.unsafe(
      `REFRESH MATERIALIZED VIEW CONCURRENTLY things_search_bench_2b`,
    );
    const during = await concurrentReaderTest("during-refresh reads");
    await refreshPromise;
    const refreshDuringMs = Number(process.hrtime.bigint() - refreshStart) / 1e6;
    await refreshPool.end({ timeout: 5 });
    await readerPool.end({ timeout: 5 });

    console.error(`  Refresh completed in ${refreshDuringMs.toFixed(0)}ms alongside concurrent readers`);

    results.concurrent_refresh_test = {
      steady_state: steady,
      during_refresh: during,
      refresh_duration_ms: refreshDuringMs,
      p95_ratio: during.p95 / steady.p95,
    };

    const ratio = during.p95 / steady.p95;
    console.error(
      `  concurrent-reader p95 ratio: ${ratio.toFixed(2)}× steady-state (threshold 2×)`,
    );
    if (ratio > 2.0) {
      const msg = `Concurrent-reader p95 during refresh = ${ratio.toFixed(2)}× steady-state > 2×`;
      console.error(`\n✗ ABORT — ${msg}`);
      abortReasons.push(msg);
      aborted = true;
    }
    if (during.p95 > steady.p95 * 10) {
      const msg = `Concurrent-reader p95 during refresh = ${during.p95.toFixed(0)}ms vs steady ${steady.p95.toFixed(0)}ms — possible blocking behavior`;
      console.error(`\n✗ ABORT — ${msg}`);
      abortReasons.push(msg);
      aborted = true;
    }
  }

  results.phase_b = {
    create_mv_ms: createMvMs,
    initial_refresh_ms: initialRefreshMs,
    pk_index_ms: pkMs,
    gin_index_ms: ginMs,
    secondary_index_ms: secMs,
    refresh_non_concurrent_ms: refreshNonConcurrent,
    refresh_non_concurrent_avg_ms: avg(refreshNonConcurrent),
    refresh_concurrent_ms: refreshConcurrent,
    refresh_concurrent_avg_ms: avg(refreshConcurrent),
    refresh_concurrent_max_ms: refreshConcurrentMax,
  };

  // --- Cleanup: DROP the MV and all its indexes ---
  console.error("\n--- Cleanup: dropping persistent MV ---");
  await sql.unsafe(`DROP MATERIALIZED VIEW IF EXISTS things_search_bench_2b`);
  console.error("  dropped things_search_bench_2b");
}

async function main() {
  await setSessionParams();

  try {
    await phaseA();

    if (aborted) {
      console.error("\n⚠ Aborted during Phase A — skipping Phase A D5 and Phase B");
    } else {
      await phaseADSFive();
    }

    if (PHASE_B && !aborted) {
      await phaseB();
    } else if (PHASE_B && aborted) {
      console.error("\n⚠ Aborted during Phase A — skipping Phase B (persistent MV)");
    } else {
      console.error("\n(Phase B skipped — pass --phase-b to run REFRESH CONCURRENTLY + concurrent-reader tests)");
      results.phase_b_note = {
        skipped: true,
        reason:
          "Phase B requires creating a persistent MATERIALIZED VIEW on prod, which needs explicit coordinator approval. Pass --phase-b after obtaining approval.",
      };
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const scrubbed = raw.replaceAll(dbUrl!, "<db-url>").replaceAll(dbHostPort, "<db-host>");
    results.fatal_error = scrubbed;
    console.error(`\n✗ Fatal: ${scrubbed}`);
    throw e;
  } finally {
    // Best effort to drop any leftover persistent MV (Phase B cleanup in finally).
    if (PHASE_B) {
      try {
        await sql.unsafe(`DROP MATERIALIZED VIEW IF EXISTS things_search_bench_2b`);
      } catch {
        /* ignore */
      }
    }
    console.error("\n=== Done ===");
    await sql.end({ timeout: 5 });
  }

  results.aborted = aborted;
  results.abort_reasons = abortReasons;

  process.stdout.write(
    JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  process.stdout.write("\n");

  if (aborted) {
    console.error(`\n✗ Aborted: ${abortReasons.length} threshold(s) exceeded`);
    process.exit(2);
  }
}

main().catch((e) => {
  const raw = e instanceof Error ? e.message : String(e);
  const scrubbed = raw.replaceAll(dbUrl!, "<db-url>").replaceAll(dbHostPort, "<db-host>");
  console.error("Benchmark failed:", scrubbed);
  process.exit(1);
});
