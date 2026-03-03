/**
 * Integration tests for the Statements System (Phase 1).
 *
 * Tests properties seeding, facts migration, and statement queries
 * against a real Postgres database.
 *
 * Requires DATABASE_URL pointing to the longterm_wiki_statements_epic DB
 * (or any DB with entities and resources for FK validation).
 *
 * Run with: DATABASE_URL=postgresql://localhost:5432/longterm_wiki_statements_epic pnpm --filter wiki-server test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq, and, isNull, desc } from "drizzle-orm";
import * as schema from "../schema.js";
import { seedProperties } from "../../scripts/seed-properties.js";
import { migrateFacts } from "../../scripts/migrate-facts-to-statements.js";

const DATABASE_URL = process.env.DATABASE_URL;

const describeWithDb = DATABASE_URL ? describe : describe.skip;

describeWithDb("Integration: Statements System", () => {
  let sqlConn: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    sqlConn = postgres(DATABASE_URL!, { max: 3 });
    db = drizzle(sqlConn, { schema });

    // Clean up any previous test data in reverse dependency order
    await sqlConn`DELETE FROM statement_citations`;
    await sqlConn`DELETE FROM statements`;
    await sqlConn`DELETE FROM properties`;
  });

  afterAll(async () => {
    // Clean up test data
    await sqlConn`DELETE FROM statement_citations`;
    await sqlConn`DELETE FROM statements`;
    await sqlConn`DELETE FROM properties`;
    await sqlConn.end();
  });

  // ==========================================================================
  // Schema tests
  // ==========================================================================

  it("has properties table", async () => {
    const result = await sqlConn`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'properties'
    `;
    expect(result).toHaveLength(1);
  });

  it("has statements table", async () => {
    const result = await sqlConn`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'statements'
    `;
    expect(result).toHaveLength(1);
  });

  it("has statement_citations table", async () => {
    const result = await sqlConn`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'statement_citations'
    `;
    expect(result).toHaveLength(1);
  });

  // ==========================================================================
  // Properties seed tests
  // ==========================================================================

  it("seeds properties from fact-measures.yaml", async () => {
    const result = await seedProperties(db);
    expect(result.inserted).toBeGreaterThanOrEqual(30);

    // Verify count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.properties);
    expect(Number(countResult[0].count)).toBeGreaterThanOrEqual(30);
  });

  it("seeds valuation property with correct fields", async () => {
    const rows = await db
      .select()
      .from(schema.properties)
      .where(eq(schema.properties.id, "valuation"));

    expect(rows).toHaveLength(1);
    const prop = rows[0];
    expect(prop.label).toBe("Valuation");
    expect(prop.category).toBe("financial");
    expect(prop.valueType).toBe("number");
    expect(prop.unitFormatId).toBe("usd-billions");
  });

  it("seeds percent-type properties correctly", async () => {
    const rows = await db
      .select()
      .from(schema.properties)
      .where(eq(schema.properties.id, "gross-margin"));

    expect(rows).toHaveLength(1);
    const prop = rows[0];
    expect(prop.valueType).toBe("number");
    expect(prop.unitFormatId).toBe("percent");
  });

  it("seeds are idempotent — running again does not duplicate", async () => {
    // Count after first seed (already done in previous test)
    const countBefore = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.properties);
    const beforeCount = Number(countBefore[0].count);

    // Run seed again
    await seedProperties(db);

    // Count should be unchanged — no new rows created
    const countAfter = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.properties);
    expect(Number(countAfter[0].count)).toBe(beforeCount);
  });

  // ==========================================================================
  // Facts migration tests
  // ==========================================================================

  it("migrates facts from YAML files", async () => {
    const result = await migrateFacts(db);
    expect(result.inserted).toBeGreaterThanOrEqual(100);
    expect(result.citationsCreated).toBeGreaterThan(0);

    // Verify count in DB
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.statements);
    expect(Number(countResult[0].count)).toBeGreaterThanOrEqual(100);
  });

  // ==========================================================================
  // Smoke tests — specific known facts
  // ==========================================================================

  it("smoke: Anthropic latest valuation is $380B as of 2026-02", async () => {
    const rows = await db
      .select()
      .from(schema.statements)
      .where(
        and(
          eq(schema.statements.subjectEntityId, "anthropic"),
          eq(schema.statements.propertyId, "valuation"),
          isNull(schema.statements.validEnd)
        )
      )
      .orderBy(desc(schema.statements.validStart))
      .limit(1);

    expect(rows).toHaveLength(1);
    expect(rows[0].valueNumeric).toBe(380000000000);
    expect(rows[0].validStart).toBe("2026-02");
  });

  it("smoke: Anthropic interpretability team size is range [40, 60]", async () => {
    const rows = await db
      .select()
      .from(schema.statements)
      .where(
        and(
          eq(schema.statements.subjectEntityId, "anthropic"),
          eq(schema.statements.propertyId, "interpretability-team-size")
        )
      );

    expect(rows).toHaveLength(1);
    const stmt = rows[0];
    // Midpoint of [40, 60] = 50
    expect(stmt.valueNumeric).toBe(50);
    expect(stmt.valueSeries).toEqual({ low: 40, high: 60 });
  });

  it("smoke: Anthropic total-funding uses {min: 67B} format", async () => {
    const rows = await db
      .select()
      .from(schema.statements)
      .where(
        and(
          eq(schema.statements.subjectEntityId, "anthropic"),
          eq(schema.statements.propertyId, "total-funding"),
          eq(schema.statements.sourceFactKey, "anthropic.226cc0eb")
        )
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].valueNumeric).toBe(67000000000);
    expect(rows[0].valueSeries).toEqual({ min: 67000000000 });
  });

  it("smoke: OpenAI revenue ARR 2025 is $20B", async () => {
    const rows = await db
      .select()
      .from(schema.statements)
      .where(eq(schema.statements.sourceFactKey, "openai.609b9796"));

    expect(rows).toHaveLength(1);
    expect(rows[0].valueNumeric).toBe(20000000000);
    expect(rows[0].subjectEntityId).toBe("openai");
    expect(rows[0].propertyId).toBe("revenue");
  });

  it("smoke: string value stored correctly (breakeven target)", async () => {
    const rows = await db
      .select()
      .from(schema.statements)
      .where(eq(schema.statements.sourceFactKey, "anthropic.023e1116"));

    expect(rows).toHaveLength(1);
    expect(rows[0].valueText).toBe("2028");
    expect(rows[0].valueNumeric).toBeNull();
  });

  it("smoke: source_fact_key format is entity.factId", async () => {
    const rows = await db
      .select()
      .from(schema.statements)
      .where(eq(schema.statements.sourceFactKey, "anthropic.6796e194"));

    expect(rows).toHaveLength(1);
    expect(rows[0].subjectEntityId).toBe("anthropic");
  });

  // ==========================================================================
  // Citations tests
  // ==========================================================================

  it("creates citations for facts with sourceResource", async () => {
    // The anthropic.6796e194 fact has sourceResource: 8e3ff50b9ef2a1a8
    const stmtRows = await db
      .select()
      .from(schema.statements)
      .where(eq(schema.statements.sourceFactKey, "anthropic.6796e194"));

    expect(stmtRows).toHaveLength(1);
    const statementId = stmtRows[0].id;

    const citRows = await db
      .select()
      .from(schema.statementCitations)
      .where(eq(schema.statementCitations.statementId, statementId));

    expect(citRows).toHaveLength(1);
    expect(citRows[0].isPrimary).toBe(true);
    // resourceId may or may not be set depending on if that resource exists
    // in the DB — but the citation row should exist
  });

  it("creates citations for facts with source URL", async () => {
    // MIRI facts have source URLs
    const stmtRows = await db
      .select()
      .from(schema.statements)
      .where(eq(schema.statements.sourceFactKey, "miri.5fe1a7d1"));

    expect(stmtRows).toHaveLength(1);
    const statementId = stmtRows[0].id;

    const citRows = await db
      .select()
      .from(schema.statementCitations)
      .where(eq(schema.statementCitations.statementId, statementId));

    expect(citRows).toHaveLength(1);
    expect(citRows[0].url).toContain("propublica.org");
  });

  // ==========================================================================
  // Old tables untouched
  // ==========================================================================

  it("facts table still has data (old system untouched)", async () => {
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.facts);
    expect(Number(countResult[0].count)).toBeGreaterThan(0);
  });

  it("entities table still has data", async () => {
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.entities);
    expect(Number(countResult[0].count)).toBeGreaterThan(0);
  });
});
