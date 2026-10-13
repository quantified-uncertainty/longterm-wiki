/** Run against a disposable PostgreSQL database with DATABASE_URL set. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "../schema.js";

const state = vi.hoisted(() => ({
  sql: null as ReturnType<typeof postgres> | null,
  db: null as ReturnType<typeof drizzle<typeof schema>> | null,
}));
vi.mock("../db.js", () => ({
  getDb: () => state.sql,
  getDrizzleDb: () => state.db,
}));

const { scannerResultsRoute } = await import("../routes/tablebase/scanner-results.js");
const { safetyFrameworkVersionsRoute } = await import("../routes/tablebase/safety-framework-versions.js");
const { jobsRoute } = await import("../routes/operational/jobs.js");
const app = new Hono()
  .route("/scanner", scannerResultsRoute)
  .route("/versions", safetyFrameworkVersionsRoute)
  .route("/jobs", jobsRoute);
const testSchema = `production_repairs_${process.pid}`;
const folder = fileURLToPath(new URL("../../drizzle/", import.meta.url));
let createdSchema = false;
let repairFolder: string | undefined;
let repairEntries: { tag: string }[] = [];

describe("production API and migration regressions", () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL must point to a disposable test database");
    state.sql = postgres(url, {
      max: 1,
      connection: { search_path: testSchema, statement_timeout: 10000 },
    });
    state.db = drizzle(state.sql, { schema });
    await state.sql.unsafe(`CREATE SCHEMA "${testSchema}"`);
    createdSchema = true;

    // Reproduce the deployed schema: the original versions table has no notes.
    const original = readFileSync(`${folder}/0206_qua_691_safety_frameworks.sql`, "utf8");
    const ddl = original.match(/CREATE TABLE IF NOT EXISTS "safety_framework_versions" \([\s\S]*?\n\);/);
    if (!ddl) throw new Error("Original versions table definition not found");
    await state.sql.unsafe(ddl[0]);
    await state.sql.unsafe(`
      CREATE TABLE tablebase_scanner_results (
        scan_run_id text, record_type text, completeness_pct real, scanned_at timestamptz
      );
      CREATE TABLE jobs (
        id bigserial PRIMARY KEY, type text, status text,
        created_at timestamptz, started_at timestamptz, completed_at timestamptz
      );
      CREATE TABLE hallucination_risk_snapshots (
        page_id integer, score real, computed_at timestamptz
      );
      INSERT INTO hallucination_risk_snapshots VALUES
        (1, 20, now() - interval '1 day'),
        (1, 30, now() - interval '1 hour'),
        (2, 40, now()), (NULL, 5, now());
      CREATE MATERIALIZED VIEW hallucination_risk_latest AS
        SELECT DISTINCT ON (page_id) page_id, score, computed_at
        FROM hallucination_risk_snapshots ORDER BY page_id, computed_at DESC;
      CREATE TABLE __drizzle_migrations (
        id serial PRIMARY KEY, hash text NOT NULL, created_at bigint
      );
      INSERT INTO __drizzle_migrations (hash, created_at)
        VALUES ('existing-deployment-marker', 1788000300000);
    `);
    // Production has already advanced past migration 0211. Editing that old
    // migration cannot fix the missing column; a forward migration must run.
    // Restrict the fixture to these additive repairs; unrelated future
    // migrations must never run against its deliberately minimal schema.
    const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8"));
    const tags = new Set([
      "0226_repair_safety_framework_versions_notes",
      "0227_repair_hallucination_risk_latest_index",
    ]);
    repairEntries = journal.entries.filter((entry: { tag: string }) => tags.has(entry.tag));
    repairFolder = mkdtempSync(join(tmpdir(), "longtermwiki-repair-migrations-"));
    mkdirSync(join(repairFolder, "meta"));
    writeFileSync(join(repairFolder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: repairEntries }));
    for (const entry of repairEntries) {
      copyFileSync(`${folder}/${entry.tag}.sql`, join(repairFolder, `${entry.tag}.sql`));
    }
    await migrate(state.db, { migrationsFolder: repairFolder, migrationsSchema: testSchema });
  });

  beforeEach(async () => {
    await state.sql!.unsafe("TRUNCATE tablebase_scanner_results, jobs");
  });

  afterAll(async () => {
    if (createdSchema) await state.sql!.unsafe(`DROP SCHEMA "${testSchema}" CASCADE`);
    await state.sql?.end();
    if (repairFolder) rmSync(repairFolder, { recursive: true });
  });

  it("repairs the missing notes column after the migration ledger has advanced", async () => {
    const response = await app.request("/versions/all?limit=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [], total: 0 });
  });

  it("returns averages for the selected scan runs using valid PostgreSQL", async () => {
    await state.sql!.unsafe(`INSERT INTO tablebase_scanner_results VALUES
      ('old', 'grants', 1, now() - interval '3 days'),
      ('middle', 'grants', 50, now() - interval '2 days'),
      ('middle', 'grants', 75, now() - interval '2 days'),
      ('new', 'grants', 60, now() - interval '1 day'),
      ('new', 'personnel', 90, now() - interval '1 day')`);
    const response = await app.request("/scanner/trends-by-type?limit=2");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ byType: [
      { recordType: "grants", points: [
        { scanRunId: "middle", avgCompleteness: 62.5, entityCount: 2 },
        { scanRunId: "new", avgCompleteness: 60, entityCount: 1 },
      ] },
      { recordType: "personnel", points: [
        { scanRunId: "new", avgCompleteness: 90, entityCount: 1 },
      ] },
    ] });
    const single = await app.request("/scanner/trends-by-type?limit=1");
    expect(single.status).toBe(200);
    const body = await single.json();
    expect(body.byType.flatMap((type: { points: { scanRunId: string }[] }) =>
      type.points.map(point => point.scanRunId))).toEqual(["new", "new"]);
  });

  it("returns empty scanner trends without attempting an empty SQL filter", async () => {
    const response = await app.request("/scanner/trends-by-type");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ byType: [] });
  });

  it("keeps lifetime backlog counts while reporting failures by completion time", async () => {
    await state.sql!.unsafe(`INSERT INTO jobs (type, status, created_at, started_at, completed_at)
      SELECT 'auto-update', 'failed', now() - interval '30 days',
        now() - interval '30 days', now() - interval '29 days'
      FROM generate_series(1, 172);
      INSERT INTO jobs (type, status, created_at, started_at, completed_at)
      SELECT 'auto-update', 'completed', now() - interval '30 days',
        now() - interval '1 minute', now() FROM generate_series(1, 12);
      INSERT INTO jobs (type, status, created_at, started_at, completed_at)
      VALUES ('auto-update', 'failed', now(), now() - interval '1 minute', now());
      INSERT INTO jobs (type, status, created_at)
      SELECT 'auto-update', 'pending', now() - interval '30 days' FROM generate_series(1, 17)`);
    const response = await app.request("/jobs/stats?hours=24");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.hours).toBe(24);
    expect(body.totalJobs).toBe(1);
    expect(body.byType["auto-update"]).toMatchObject({
      byStatus: { failed: 173, completed: 12, pending: 17 },
      recentFinishedJobs: 13, recentFailedJobs: 1,
      avgDurationMs: 60000,
    });
    expect(body.byType["auto-update"].failureRate).toBeCloseTo(1 / 13);
  });

  it("refreshes the latest-risk view concurrently and preserves its null page row", async () => {
    await state.sql!`INSERT INTO hallucination_risk_snapshots VALUES (1, 99, now())`;
    await state.sql!.unsafe("REFRESH MATERIALIZED VIEW CONCURRENTLY hallucination_risk_latest");
    const rows = await state.sql!`SELECT page_id, score FROM hallucination_risk_latest ORDER BY page_id NULLS LAST`;
    expect(Array.from(rows)).toEqual([
      { page_id: 1, score: 99 }, { page_id: 2, score: 40 }, { page_id: null, score: 5 },
    ]);
  });

  it("replays the additive repairs without losing existing notes or risk rows", async () => {
    await state.sql!.unsafe(`INSERT INTO safety_framework_versions
      (id, framework_id, version_label, version_sort_order, discovered_date, source_url, content_hash, notes)
      VALUES ('fixture-version', 'fixture-framework', 'v1', 1, current_date, 'https://example.com', 'fixture-hash', 'preserve this note')`);
    for (let replay = 0; replay < 2; replay++) {
      for (const entry of repairEntries) {
        await state.sql!.unsafe(readFileSync(`${folder}/${entry.tag}.sql`, "utf8"));
      }
    }
    const rows = await state.sql!`SELECT notes FROM safety_framework_versions`;
    expect(rows[0].notes).toBe("preserve this note");
    const risk = await state.sql!`SELECT count(*)::int as count FROM hallucination_risk_latest`;
    expect(risk[0].count).toBe(3);
  });
});
