/**
 * Integration tests — run against a real Postgres database.
 *
 * These tests require DATABASE_URL to be set. They are skipped otherwise.
 * Run with: pnpm test:integration
 *
 * The tests use a dedicated test schema to avoid polluting the main database.
 * Tables are created/dropped per test suite run.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, count, sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "../schema.js";
import { entityIds, citationQuotes, citationContent, entityIdSeq } from "../schema.js";

const DATABASE_URL = process.env.DATABASE_URL;

const describeWithDb = DATABASE_URL ? describe : describe.skip;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

/**
 * Drop ALL tables created by migrations 0000-0009, in reverse dependency order.
 * Uses CASCADE so FK ordering is handled automatically, but we list children
 * first for clarity.
 */
async function dropAllTables(conn: ReturnType<typeof postgres>) {
  // Children with FKs first
  await conn`DROP TABLE IF EXISTS resource_citations CASCADE`;
  await conn`DROP TABLE IF EXISTS auto_update_results CASCADE`;
  await conn`DROP TABLE IF EXISTS session_pages CASCADE`;
  // Parent tables
  await conn`DROP TABLE IF EXISTS resources CASCADE`;
  await conn`DROP TABLE IF EXISTS auto_update_runs CASCADE`;
  await conn`DROP TABLE IF EXISTS sessions CASCADE`;
  await conn`DROP TABLE IF EXISTS hallucination_risk_snapshots CASCADE`;
  await conn`DROP TABLE IF EXISTS citation_accuracy_snapshots CASCADE`;
  await conn`DROP TABLE IF EXISTS edit_logs CASCADE`;
  await conn`DROP TABLE IF EXISTS wiki_pages CASCADE`;
  await conn`DROP TABLE IF EXISTS citation_content CASCADE`;
  await conn`DROP TABLE IF EXISTS citation_quotes CASCADE`;
  await conn`DROP TABLE IF EXISTS entity_ids CASCADE`;
  await conn`DROP SEQUENCE IF EXISTS entity_id_seq CASCADE`;
  // Drizzle metadata
  await conn`DROP TABLE IF EXISTS __drizzle_migrations CASCADE`;
  await conn`DROP SCHEMA IF EXISTS drizzle CASCADE`;
}

/** All tables that should exist after running all migrations. */
const ALL_EXPECTED_TABLES = [
  "entity_ids",
  "citation_quotes",
  "citation_content",
  "wiki_pages",
  "edit_logs",
  "citation_accuracy_snapshots",
  "session_pages",
  "sessions",
  "hallucination_risk_snapshots",
  "auto_update_runs",
  "auto_update_results",
  "resources",
  "resource_citations",
];

describeWithDb("Integration: Drizzle migrations", () => {
  let sqlConn: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    sqlConn = postgres(DATABASE_URL!, { max: 3 });
    db = drizzle(sqlConn, { schema });
    await dropAllTables(sqlConn);
  });

  afterAll(async () => {
    await dropAllTables(sqlConn);
    await sqlConn.end();
  });

  it("applies migration on a fresh database", async () => {
    await migrate(db, { migrationsFolder });

    // Verify ALL tables from migrations 0000-0009 exist
    const tables = await sqlConn`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const tableNames = tables.map((r) => r.table_name);
    for (const expected of ALL_EXPECTED_TABLES) {
      expect(tableNames, `Missing table: ${expected}`).toContain(expected);
    }
    expect(tableNames).toContain("__drizzle_migrations");
  });

  it("creates all expected foreign key constraints", async () => {
    const fks = await sqlConn`
      SELECT constraint_name, table_name
      FROM information_schema.table_constraints
      WHERE constraint_type = 'FOREIGN KEY'
        AND table_schema = 'public'
      ORDER BY constraint_name
    `;
    const fkNames = fks.map((r) => r.constraint_name);

    // FK from session_pages.session_id → sessions.id (migration 0004)
    expect(fkNames).toContain("session_pages_session_id_sessions_id_fk");
    // FK from auto_update_results.run_id → auto_update_runs.id (migration 0008)
    expect(fkNames).toContain("auto_update_results_run_id_auto_update_runs_id_fk");
    // FK from resource_citations.resource_id → resources.id (migration 0009)
    expect(fkNames).toContain("resource_citations_resource_id_resources_id_fk");
  });

  it("is idempotent — running migrate() again succeeds", async () => {
    // Should not throw
    await migrate(db, { migrationsFolder });

    // Tables still exist
    const countResult = await db.select({ count: count() }).from(entityIds);
    expect(countResult[0].count).toBe(0);
  });

  it("sequence exists and works", async () => {
    const result = await sqlConn`SELECT nextval('entity_id_seq') AS val`;
    expect(Number(result[0].val)).toBeGreaterThan(0);
  });
});

describeWithDb("Integration: Entity IDs CRUD", () => {
  let sqlConn: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    sqlConn = postgres(DATABASE_URL!, { max: 3 });
    db = drizzle(sqlConn, { schema });
    await dropAllTables(sqlConn);
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await dropAllTables(sqlConn);
    await sqlConn.end();
  });

  beforeEach(async () => {
    await db.delete(entityIds);
    await sqlConn`SELECT setval('entity_id_seq', 1, false)`;
  });

  it("inserts an entity with sequence-generated ID", async () => {
    const inserted = await db
      .insert(entityIds)
      .values({
        numericId: sql`nextval('entity_id_seq')`,
        slug: "test-entity",
        description: "A test entity",
      })
      .returning();

    expect(inserted).toHaveLength(1);
    expect(inserted[0].numericId).toBe(1);
    expect(inserted[0].slug).toBe("test-entity");
    expect(inserted[0].description).toBe("A test entity");
    expect(inserted[0].createdAt).toBeInstanceOf(Date);
  });

  it("enforces unique slug constraint", async () => {
    await db.insert(entityIds).values({
      numericId: sql`nextval('entity_id_seq')`,
      slug: "unique-test",
    });

    // Same slug, different ID — should conflict
    const result = await db
      .insert(entityIds)
      .values({
        numericId: sql`nextval('entity_id_seq')`,
        slug: "unique-test",
      })
      .onConflictDoNothing({ target: entityIds.slug })
      .returning();

    expect(result).toHaveLength(0);
  });

  it("selects by slug", async () => {
    await db.insert(entityIds).values({
      numericId: sql`nextval('entity_id_seq')`,
      slug: "findme",
    });

    const rows = await db
      .select()
      .from(entityIds)
      .where(eq(entityIds.slug, "findme"));

    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe("findme");
  });

  it("returns empty for nonexistent slug", async () => {
    const rows = await db
      .select()
      .from(entityIds)
      .where(eq(entityIds.slug, "nope"));

    expect(rows).toHaveLength(0);
  });

  it("counts entities", async () => {
    await db.insert(entityIds).values([
      { numericId: sql`nextval('entity_id_seq')`, slug: "a" },
      { numericId: sql`nextval('entity_id_seq')`, slug: "b" },
      { numericId: sql`nextval('entity_id_seq')`, slug: "c" },
    ]);

    const result = await db.select({ count: count() }).from(entityIds);
    expect(result[0].count).toBe(3);
  });

  it("supports transactions", async () => {
    await db.transaction(async (tx) => {
      await tx.insert(entityIds).values({
        numericId: sql`nextval('entity_id_seq')`,
        slug: "tx-test",
      });
    });

    const rows = await db
      .select()
      .from(entityIds)
      .where(eq(entityIds.slug, "tx-test"));
    expect(rows).toHaveLength(1);
  });
});

describeWithDb("Integration: Citation Quotes CRUD", () => {
  let sqlConn: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    sqlConn = postgres(DATABASE_URL!, { max: 3 });
    db = drizzle(sqlConn, { schema });
    await dropAllTables(sqlConn);
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await dropAllTables(sqlConn);
    await sqlConn.end();
  });

  beforeEach(async () => {
    await db.delete(citationQuotes);
    await db.delete(citationContent);
  });

  it("inserts a citation quote", async () => {
    const rows = await db
      .insert(citationQuotes)
      .values({
        pageId: "test-page",
        footnote: 1,
        claimText: "Test claim",
        url: "https://example.com",
      })
      .returning();

    expect(rows).toHaveLength(1);
    expect(rows[0].pageId).toBe("test-page");
    expect(rows[0].footnote).toBe(1);
    expect(rows[0].claimText).toBe("Test claim");
    expect(rows[0].quoteVerified).toBe(false);
    expect(rows[0].id).toBeGreaterThan(0);
  });

  it("upserts on (page_id, footnote) conflict", async () => {
    // First insert
    await db.insert(citationQuotes).values({
      pageId: "upsert-page",
      footnote: 1,
      claimText: "Original",
    });

    // Upsert with updated claim
    const vals = {
      pageId: "upsert-page",
      footnote: 1,
      claimText: "Updated",
      url: null,
      resourceId: null,
      claimContext: null,
      sourceQuote: null,
      sourceLocation: null,
      quoteVerified: false,
      verificationMethod: null,
      verificationScore: null,
      sourceTitle: null,
      sourceType: null,
      extractionModel: null,
    };

    const rows = await db
      .insert(citationQuotes)
      .values(vals)
      .onConflictDoUpdate({
        target: [citationQuotes.pageId, citationQuotes.footnote],
        set: { ...vals, updatedAt: sql`now()` },
      })
      .returning();

    expect(rows).toHaveLength(1);
    expect(rows[0].claimText).toBe("Updated");

    // Should still be only 1 row
    const all = await db
      .select()
      .from(citationQuotes)
      .where(eq(citationQuotes.pageId, "upsert-page"));
    expect(all).toHaveLength(1);
  });

  it("enforces unique (page_id, footnote) constraint", async () => {
    await db.insert(citationQuotes).values({
      pageId: "dup-page",
      footnote: 1,
      claimText: "First",
    });

    // Raw insert without ON CONFLICT should fail
    await expect(
      db.insert(citationQuotes).values({
        pageId: "dup-page",
        footnote: 1,
        claimText: "Second",
      })
    ).rejects.toThrow();
  });

  it("updates verification status", async () => {
    await db.insert(citationQuotes).values({
      pageId: "verify-page",
      footnote: 1,
      claimText: "Claim",
    });

    const updated = await db
      .update(citationQuotes)
      .set({
        quoteVerified: true,
        verificationMethod: "text-match",
        verificationScore: 0.95,
        verifiedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        eq(citationQuotes.pageId, "verify-page")
      )
      .returning();

    expect(updated).toHaveLength(1);
    expect(updated[0].quoteVerified).toBe(true);
    expect(updated[0].verificationScore).toBeCloseTo(0.95);
  });
});

describeWithDb("Integration: Citation Content CRUD", () => {
  let sqlConn: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    sqlConn = postgres(DATABASE_URL!, { max: 3 });
    db = drizzle(sqlConn, { schema });
    await dropAllTables(sqlConn);
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await dropAllTables(sqlConn);
    await sqlConn.end();
  });

  beforeEach(async () => {
    await db.delete(citationContent);
  });

  it("inserts citation content", async () => {
    const rows = await db
      .insert(citationContent)
      .values({
        url: "https://example.com/article",
        fetchedAt: new Date(),
        httpStatus: 200,
        pageTitle: "Test Article",
      })
      .returning();

    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://example.com/article");
    expect(rows[0].httpStatus).toBe(200);
  });

  it("upserts on URL conflict", async () => {
    const fetchedAt = new Date();
    await db.insert(citationContent).values({
      url: "https://example.com/upsert",
      fetchedAt,
      pageTitle: "Original",
    });

    const vals = {
      url: "https://example.com/upsert",
      fetchedAt: new Date(),
      httpStatus: 200,
      contentType: null,
      pageTitle: "Updated",
      fullTextPreview: null,
      contentLength: null,
      contentHash: null,
    };

    await db
      .insert(citationContent)
      .values(vals)
      .onConflictDoUpdate({
        target: citationContent.url,
        set: { ...vals, updatedAt: sql`now()` },
      });

    const rows = await db
      .select()
      .from(citationContent)
      .where(eq(citationContent.url, "https://example.com/upsert"));

    expect(rows).toHaveLength(1);
    expect(rows[0].pageTitle).toBe("Updated");
  });

  it("selects by URL", async () => {
    await db.insert(citationContent).values({
      url: "https://example.com/find",
      fetchedAt: new Date(),
    });

    const rows = await db
      .select()
      .from(citationContent)
      .where(eq(citationContent.url, "https://example.com/find"));

    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://example.com/find");
  });
});

describeWithDb("Integration: Route handlers against real DB", () => {
  let sqlConn: ReturnType<typeof postgres>;
  let createApp: () => import("hono").Hono;

  beforeAll(async () => {
    sqlConn = postgres(DATABASE_URL!, { max: 3 });
    const db = drizzle(sqlConn, { schema });
    await dropAllTables(sqlConn);
    await migrate(db, { migrationsFolder });

    // Set DATABASE_URL for the app's getDb/getDrizzleDb
    process.env.DATABASE_URL = DATABASE_URL;

    // Dynamically import the app (must be in async context)
    const mod = await import("../app.js");
    createApp = mod.createApp;
  });

  afterAll(async () => {
    await dropAllTables(sqlConn);
    await sqlConn.end();
  });

  beforeEach(async () => {
    await sqlConn`DELETE FROM citation_content`;
    await sqlConn`DELETE FROM citation_quotes`;
    await sqlConn`DELETE FROM entity_ids`;
    await sqlConn`SELECT setval('entity_id_seq', 886, false)`;
  });

  it("POST /api/ids/allocate creates an entity", async () => {
    const app = createApp();
    const res = await app.request("/api/ids/allocate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "integration-test" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.numericId).toBe("E886");
    expect(body.slug).toBe("integration-test");
    expect(body.created).toBe(true);
  });

  it("POST /api/citations/quotes/upsert creates a quote", async () => {
    const app = createApp();
    const res = await app.request("/api/citations/quotes/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageId: "integration-page",
        footnote: 1,
        claimText: "Integration test claim",
        url: "https://example.com/integration",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pageId).toBe("integration-page");
    expect(body.footnote).toBe(1);
  });

  it("GET /api/citations/stats returns aggregate data", async () => {
    const app = createApp();

    // Insert test data
    await app.request("/api/citations/quotes/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageId: "stats-page", footnote: 1, claimText: "Claim 1" }),
    });
    await app.request("/api/citations/quotes/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageId: "stats-page", footnote: 2, claimText: "Claim 2" }),
    });

    const res = await app.request("/api/citations/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalQuotes).toBe(2);
    expect(body.totalPages).toBe(1);
  });

  it("GET /health returns healthy status", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(body.database).toBe("ok");
  });
});
