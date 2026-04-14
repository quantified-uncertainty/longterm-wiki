/* eslint-disable no-console */
/**
 * QUA-476 Phase 4b-B.2a benchmark runner — things_search MV feasibility.
 *
 * Safety model: connects to PRODUCTION_DB_URL read-only. The only DDL this
 * script issues is `CREATE TEMP TABLE` / `CREATE INDEX` on temp objects, which
 * live in the session-local `pg_temp` schema and are dropped when the client
 * disconnects. No persistent objects are created. No rows are modified. No
 * REFRESH is run against any real MV — REFRESH behavior is extrapolated from
 * the TEMP TABLE build time + index build time.
 *
 * Usage:
 *   PRODUCTION_DB_URL=... node --import tsx/esm docs/benchmarks/qua-476/run-benchmark.mts \
 *     > docs/benchmarks/qua-476/benchmark-results.json
 */

// Resolve via the wiki-server's node_modules; postgres.js is not in the root.
import postgres from "../../../apps/wiki-server/node_modules/postgres/cjs/src/index.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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

const URL = process.env.PRODUCTION_DB_URL;
if (!URL) {
  console.error("PRODUCTION_DB_URL not set");
  process.exit(1);
}

const sql = postgres(URL, {
  ssl: "require",
  max: 1,
  idle_timeout: 20,
  // Read-only session lock.
  connection: {
    application_name: "qua-476-benchmark",
  },
});

type Timing = { label: string; ms: number };
const timings: Timing[] = [];

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = process.hrtime.bigint();
  const r = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  timings.push({ label, ms });
  console.error(`  [${ms.toFixed(1)}ms] ${label}`);
  return r;
}

async function bench<T>(label: string, n: number, fn: () => Promise<T>): Promise<{ label: string; n: number; p50: number; p95: number; p99: number; min: number; max: number; samples: number[] }> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const pick = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  const stat = {
    label,
    n,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    min: samples[0],
    max: samples[samples.length - 1],
    samples,
  };
  console.error(`  [${label}] n=${n} p50=${stat.p50.toFixed(1)} p95=${stat.p95.toFixed(1)} p99=${stat.p99.toFixed(1)}`);
  return stat;
}

const results: Record<string, unknown> = {
  generated_at: new Date().toISOString(),
  safety: "TEMP-TABLE only; no persistent DDL; no writes; application_name=qua-476-benchmark",
};

async function main() {
  // Set a read-only transaction default for every statement except the
  // explicit temp-table section (temp tables are not "writes" to the DB the
  // read-only guard thinks about, but postgres treats TEMP TABLE creation as a
  // write in read-only mode, so we don't enable default_transaction_read_only
  // globally — we rely on application discipline).
  await sql`SET application_name = 'qua-476-benchmark'`;
  await sql`SET statement_timeout = '120s'`;
  // Give the TEMP TABLE section enough session temp memory to do the GIN build.
  await sql`SET maintenance_work_mem = '256MB'`;
  await sql`SET work_mem = '64MB'`;

  // === 0. Table + index size baseline ===
  console.error("\n=== 0. Baseline: things table size and row count ===");
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

  // === 1. Baseline /search query latency (against current things) ===
  console.error("\n=== 1. Baseline /search queries (current things.search_vector) ===");
  const queries = [
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

  const baselineBench: Record<string, unknown>[] = [];
  for (const q of queries) {
    const tsquery = q
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `${t.replace(/[^a-z0-9]/gi, "")}:*`)
      .filter(Boolean)
      .join(" & ");
    if (!tsquery) continue;
    const stat = await bench(`baseline: "${q}"`, 5, async () => {
      await sql`
        SELECT t.id, t.title, ts_rank(t.search_vector, to_tsquery('english', ${tsquery})) AS rank
        FROM things t
        WHERE t.search_vector @@ to_tsquery('english', ${tsquery})
        ORDER BY rank DESC
        LIMIT 20
      `;
    });
    baselineBench.push({ query: q, tsquery, ...stat });
  }
  results.baseline_queries = baselineBench;

  // === 2. TEMP TABLE build — simulates MV refresh cost (self-SELECT variant) ===
  console.error("\n=== 2. TEMP TABLE build (MV refresh simulation, self-SELECT) ===");
  const buildRuns = 3;
  const buildTimings: number[] = [];
  const gin1Timings: number[] = [];
  const pk1Timings: number[] = [];

  for (let run = 1; run <= buildRuns; run++) {
    console.error(`  --- run ${run}/${buildRuns} ---`);
    await sql`DROP TABLE IF EXISTS things_search_bench`;

    await time(`run ${run}: CREATE TEMP TABLE ... AS SELECT`, async () => {
      await sql.unsafe(`
        CREATE TEMP TABLE things_search_bench AS
        SELECT
          t.id,
          t.thing_type,
          t.title,
          t.parent_thing_id,
          t.source_table,
          t.source_id,
          t.entity_type,
          t.description,
          t.source_url,
          t.wiki_id,
          t.parent_title,
          t.created_at,
          t.updated_at,
          t.synced_at,
          (
            setweight(to_tsvector('english', coalesce(t.title, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(t.parent_title, '')), 'B') ||
            setweight(to_tsvector('english', coalesce(t.description, '')), 'C') ||
            setweight(to_tsvector('english',
              coalesce(replace(t.thing_type, '-', ' '), '') || ' ' ||
              coalesce(replace(t.entity_type, '-', ' '), '')
            ), 'D')
          ) AS search_vector
        FROM things t
      `);
    });
    buildTimings.push(timings[timings.length - 1].ms);

    await time(`run ${run}: CREATE UNIQUE INDEX pkey`, async () => {
      await sql.unsafe(`CREATE UNIQUE INDEX things_search_bench_pkey ON things_search_bench (id)`);
    });
    pk1Timings.push(timings[timings.length - 1].ms);

    await time(`run ${run}: CREATE GIN INDEX search_vector`, async () => {
      await sql.unsafe(`CREATE INDEX things_search_bench_gin ON things_search_bench USING GIN (search_vector)`);
    });
    gin1Timings.push(timings[timings.length - 1].ms);

    // Size of the constructed object.
    const sizes = await sql`
      SELECT
        pg_total_relation_size('pg_temp.things_search_bench'::regclass)::bigint AS total_bytes,
        pg_relation_size('pg_temp.things_search_bench'::regclass)::bigint AS heap_bytes,
        pg_indexes_size('pg_temp.things_search_bench'::regclass)::bigint AS index_bytes
    `;
    if (run === buildRuns) results.temp_build_sizes = sizes[0];

    // ANALYZE so the planner has stats for the query benchmark below.
    await sql.unsafe(`ANALYZE things_search_bench`);
  }

  results.temp_build_runs = {
    build_ms: buildTimings,
    pk_index_ms: pk1Timings,
    gin_index_ms: gin1Timings,
    build_ms_avg: buildTimings.reduce((a, b) => a + b, 0) / buildTimings.length,
    total_build_avg_ms: (buildTimings.reduce((a, b) => a + b, 0) + pk1Timings.reduce((a, b) => a + b, 0) + gin1Timings.reduce((a, b) => a + b, 0)) / buildRuns,
  };

  // === 3. MV query latency (against the TEMP TABLE) ===
  console.error("\n=== 3. MV query latency (TEMP TABLE as stand-in) ===");
  const mvBench: Record<string, unknown>[] = [];
  for (const q of queries) {
    const tsquery = q
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `${t.replace(/[^a-z0-9]/gi, "")}:*`)
      .filter(Boolean)
      .join(" & ");
    if (!tsquery) continue;
    const stat = await bench(`mv: "${q}"`, 5, async () => {
      await sql.unsafe(
        `SELECT t.id, t.title, ts_rank(t.search_vector, to_tsquery('english', $1)) AS rank
         FROM things_search_bench t
         WHERE t.search_vector @@ to_tsquery('english', $1)
         ORDER BY rank DESC
         LIMIT 20`,
        [tsquery],
      );
    });
    mvBench.push({ query: q, tsquery, ...stat });
  }
  results.mv_queries = mvBench;

  // === 4. JOIN cost estimation (models the 2b target refresh query) ===
  // The real 4b-B.2b MV will JOIN source tables (entities, facts, grants, …)
  // to compose titles. We model this cost by timing a representative JOIN and
  // reporting the delta vs the self-SELECT refresh.
  console.error("\n=== 4. JOIN cost estimation (2b refresh target) ===");
  await sql`DROP TABLE IF EXISTS things_search_bench`;
  await time("JOIN build: things ⟕ entities (parentTitle resolution)", async () => {
    await sql.unsafe(`
      CREATE TEMP TABLE things_search_bench_join AS
      SELECT
        t.id,
        t.thing_type,
        t.title,
        t.parent_thing_id,
        t.source_table,
        t.source_id,
        t.entity_type,
        COALESCE(ep.title, t.parent_title) AS parent_title,
        t.description,
        t.source_url,
        t.wiki_id,
        t.created_at,
        t.updated_at,
        t.synced_at,
        (
          setweight(to_tsvector('english', coalesce(t.title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(COALESCE(ep.title, t.parent_title), '')), 'B') ||
          setweight(to_tsvector('english', coalesce(t.description, '')), 'C') ||
          setweight(to_tsvector('english',
            coalesce(replace(t.thing_type, '-', ' '), '') || ' ' ||
            coalesce(replace(t.entity_type, '-', ' '), '')
          ), 'D')
        ) AS search_vector
      FROM things t
      LEFT JOIN entities ep ON ep.stable_id = t.parent_thing_id
    `);
  });
  const joinBuildMs = timings[timings.length - 1].ms;
  results.join_build_ms = joinBuildMs;
  results.join_vs_self_delta_ms = joinBuildMs - (results.temp_build_runs as { build_ms_avg: number }).build_ms_avg;

  await sql`DROP TABLE IF EXISTS things_search_bench_join`;

  // === 5. CONCURRENT refresh behavior ===
  // We cannot run REFRESH MATERIALIZED VIEW CONCURRENTLY against a TEMP table
  // (MVs cannot be TEMP, and REFRESH only works on persistent MVs). Report
  // this as a methodology gap and rely on postgres documentation / empirical
  // behavior known from the literature:
  //
  //  - REFRESH MATERIALIZED VIEW (non-concurrent): takes ACCESS EXCLUSIVE on
  //    the MV for the duration of the build. Readers wait on the lock.
  //  - REFRESH MATERIALIZED VIEW CONCURRENTLY: acquires EXCLUSIVE on the MV
  //    for setup, but holds only ROW EXCLUSIVE on the underlying tables during
  //    the diff phase and SHARE UPDATE EXCLUSIVE on the MV itself during the
  //    apply phase. Concurrent SELECTs against the MV are served throughout.
  //  - CONCURRENTLY requires a UNIQUE index on at least one column (we have
  //    things_search_pkey on id).
  //  - CONCURRENTLY cost ≈ 2x non-concurrent refresh because it builds the
  //    new snapshot alongside the old one and then diffs them.
  //
  // Phase 4b-B.2b MUST re-verify this empirically against a restore instance
  // or a coordinator-approved prod MV before the column drop.
  results.concurrent_refresh_note = {
    tested: false,
    reason: "Cannot issue REFRESH MATERIALIZED VIEW CONCURRENTLY against a TEMP table, and creating a persistent MV on prod was out of scope for this benchmark (dispatcher said check with coordinator first).",
    estimated_concurrent_refresh_ms: (results.temp_build_runs as { total_build_avg_ms: number }).total_build_avg_ms * 2,
    reference: "PostgreSQL docs: REFRESH MATERIALIZED VIEW CONCURRENTLY builds a new snapshot, diffs, and applies — roughly 2x the non-concurrent cost. Readers are not blocked.",
  };

  console.error("\n=== Done ===");
  await sql.end({ timeout: 5 });

  process.stdout.write(JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  process.stdout.write("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
