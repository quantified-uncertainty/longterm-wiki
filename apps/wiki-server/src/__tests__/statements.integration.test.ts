/**
 * Integration tests for the Statements System (Phases 1–2).
 *
 * Tests properties seeding, facts migration, claims migration, and statement queries
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
import { migrateClaims } from "../../scripts/migrate-claims-to-statements.js";

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

  // ==========================================================================
  // Claims migration tests (Phase 2)
  // ==========================================================================

  // Seed test claims for migration tests.
  // These use entityId='anthropic' so they match the default entity filter.
  const TEST_CLAIM_ENTITY = "anthropic";

  it("seeds test claims for migration", async () => {
    // Clean up any previous test claims
    await sqlConn`DELETE FROM claim_sources WHERE claim_id IN (
      SELECT id FROM claims WHERE claim_text LIKE '[TEST]%'
    )`;
    await sqlConn`DELETE FROM claims WHERE claim_text LIKE '[TEST]%'`;

    // Insert structured endorsed claim with numeric value
    await sqlConn`
      INSERT INTO claims (entity_id, entity_type, claim_type, claim_text, claim_mode,
        subject_entity, property, value_numeric, value_unit, as_of, section)
      VALUES (${TEST_CLAIM_ENTITY}, 'organization', 'numeric', '[TEST] Anthropic valuation test',
        'endorsed', 'anthropic', 'valuation', 61000000000, 'USD', '2025-03', 'Funding')
    `;

    // Insert attributed claim
    await sqlConn`
      INSERT INTO claims (entity_id, entity_type, claim_type, claim_text, claim_mode,
        attributed_to, subject_entity)
      VALUES (${TEST_CLAIM_ENTITY}, 'organization', 'evaluative',
        '[TEST] Anthropic is leading AI safety research', 'attributed',
        'dario-amodei', 'anthropic')
    `;

    // Insert claim with range values (valueLow + valueHigh)
    await sqlConn`
      INSERT INTO claims (entity_id, entity_type, claim_type, claim_text, claim_mode,
        subject_entity, property, value_low, value_high, value_unit, as_of)
      VALUES (${TEST_CLAIM_ENTITY}, 'organization', 'numeric',
        '[TEST] Anthropic employee count range', 'endorsed',
        'anthropic', 'employee_count', 1500, 2000, 'count', '2025-06')
    `;

    // Insert claim with qualifiers
    await sqlConn`
      INSERT INTO claims (entity_id, entity_type, claim_type, claim_text, claim_mode,
        subject_entity, property, value_numeric, value_unit, qualifiers)
      VALUES (${TEST_CLAIM_ENTITY}, 'organization', 'numeric',
        '[TEST] Anthropic Series D funding', 'endorsed',
        'anthropic', 'funding_round_amount', 4000000000, 'USD',
        '{"round": "Series D", "lead": "Google"}'::jsonb)
    `;

    // Insert claim with structured_value (text, no numeric)
    await sqlConn`
      INSERT INTO claims (entity_id, entity_type, claim_type, claim_text, claim_mode,
        subject_entity, property, structured_value)
      VALUES (${TEST_CLAIM_ENTITY}, 'organization', 'factual',
        '[TEST] Anthropic HQ location', 'endorsed',
        'anthropic', 'headquarters', 'San Francisco, CA')
    `;

    // Insert claim that has a factId matching an existing YAML fact (for dedup test)
    await sqlConn`
      INSERT INTO claims (entity_id, entity_type, claim_type, claim_text, claim_mode,
        subject_entity, fact_id, value_numeric)
      VALUES (${TEST_CLAIM_ENTITY}, 'organization', 'numeric',
        '[TEST] Duplicate of YAML fact', 'endorsed',
        'anthropic', 'anthropic.6796e194', 380000000000)
    `;

    // Verify claims were seeded
    const count = await sqlConn`
      SELECT count(*) as cnt FROM claims WHERE claim_text LIKE '[TEST]%'
    `;
    expect(Number(count[0].cnt)).toBe(6);
  });

  it("seeds test claim sources", async () => {
    // Add sources to the first test claim (valuation)
    const claimRows = await sqlConn`
      SELECT id FROM claims
      WHERE claim_text = '[TEST] Anthropic valuation test'
      LIMIT 1
    `;
    expect(claimRows).toHaveLength(1);
    const claimId = claimRows[0].id;

    await sqlConn`
      INSERT INTO claim_sources (claim_id, url, source_quote, is_primary, source_location)
      VALUES (${claimId}, 'https://example.com/anthropic-funding',
        'Anthropic raised at a $61B valuation', true, 'paragraph 3')
    `;

    const sourceCount = await sqlConn`
      SELECT count(*) as cnt FROM claim_sources WHERE claim_id = ${claimId}
    `;
    expect(Number(sourceCount[0].cnt)).toBe(1);
  });

  it("migrates claims to statements", async () => {
    const result = await migrateClaims(db, TEST_CLAIM_ENTITY);

    // Should insert test claims (minus the dedup one)
    expect(result.inserted).toBeGreaterThanOrEqual(5);
    expect(result.deduplicated).toBeGreaterThanOrEqual(1);
    expect(result.citationsCreated).toBeGreaterThanOrEqual(1);
  });

  it("claims migration is idempotent", async () => {
    const countBefore = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.statements);
    const before = Number(countBefore[0].count);

    // Run migration again
    const result = await migrateClaims(db, TEST_CLAIM_ENTITY);

    // All should be skipped
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(5);

    const countAfter = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.statements);
    expect(Number(countAfter[0].count)).toBe(before);
  });

  it("maps endorsed → structured variety", async () => {
    const rows = await db
      .select()
      .from(schema.statements)
      .where(
        sql`${schema.statements.sourceFactKey} LIKE 'claim:%'
          AND ${schema.statements.statementText} = '[TEST] Anthropic valuation test'`
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].variety).toBe("structured");
    expect(rows[0].valueNumeric).toBe(61000000000);
    expect(rows[0].valueUnit).toBe("USD");
    expect(rows[0].validStart).toBe("2025-03");
  });

  it("maps attributed variety correctly", async () => {
    const rows = await db
      .select()
      .from(schema.statements)
      .where(
        sql`${schema.statements.sourceFactKey} LIKE 'claim:%'
          AND ${schema.statements.statementText} = '[TEST] Anthropic is leading AI safety research'`
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].variety).toBe("attributed");
    // attributedTo may be null if dario-amodei doesn't exist in entities
  });

  it("resolves property aliases (snake_case → kebab-case)", async () => {
    // employee_count → headcount
    const rows = await db
      .select()
      .from(schema.statements)
      .where(
        sql`${schema.statements.sourceFactKey} LIKE 'claim:%'
          AND ${schema.statements.statementText} = '[TEST] Anthropic employee count range'`
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].propertyId).toBe("headcount");
  });

  it("converts range values to valueSeries", async () => {
    const rows = await db
      .select()
      .from(schema.statements)
      .where(
        sql`${schema.statements.sourceFactKey} LIKE 'claim:%'
          AND ${schema.statements.statementText} = '[TEST] Anthropic employee count range'`
      );

    expect(rows).toHaveLength(1);
    const stmt = rows[0];
    // Midpoint of [1500, 2000] = 1750
    expect(stmt.valueNumeric).toBe(1750);
    expect(stmt.valueSeries).toEqual({ low: 1500, high: 2000 });
  });

  it("serializes qualifiers to qualifierKey", async () => {
    const rows = await db
      .select()
      .from(schema.statements)
      .where(
        sql`${schema.statements.sourceFactKey} LIKE 'claim:%'
          AND ${schema.statements.statementText} = '[TEST] Anthropic Series D funding'`
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].qualifierKey).toBe("round:Series D");
    // Second qualifier goes to note
    expect(rows[0].note).toContain("lead:Google");
  });

  it("resolves funding_round_amount alias to funding-round", async () => {
    const rows = await db
      .select()
      .from(schema.statements)
      .where(
        sql`${schema.statements.sourceFactKey} LIKE 'claim:%'
          AND ${schema.statements.statementText} = '[TEST] Anthropic Series D funding'`
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].propertyId).toBe("funding-round");
  });

  it("stores structured_value as valueText", async () => {
    const rows = await db
      .select()
      .from(schema.statements)
      .where(
        sql`${schema.statements.sourceFactKey} LIKE 'claim:%'
          AND ${schema.statements.statementText} = '[TEST] Anthropic HQ location'`
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].valueText).toBe("San Francisco, CA");
    expect(rows[0].valueNumeric).toBeNull();
  });

  it("migrates claimSources to statementCitations", async () => {
    const stmtRows = await db
      .select()
      .from(schema.statements)
      .where(
        sql`${schema.statements.sourceFactKey} LIKE 'claim:%'
          AND ${schema.statements.statementText} = '[TEST] Anthropic valuation test'`
      );

    expect(stmtRows).toHaveLength(1);
    const statementId = stmtRows[0].id;

    const citRows = await db
      .select()
      .from(schema.statementCitations)
      .where(eq(schema.statementCitations.statementId, statementId));

    expect(citRows).toHaveLength(1);
    expect(citRows[0].url).toBe("https://example.com/anthropic-funding");
    expect(citRows[0].sourceQuote).toBe(
      "Anthropic raised at a $61B valuation"
    );
    expect(citRows[0].isPrimary).toBe(true);
    expect(citRows[0].locationNote).toBe("paragraph 3");
  });

  it("deduplicates claims that match existing YAML facts via factId", async () => {
    // The test claim with factId='anthropic.6796e194' should have been deduplicated
    const rows = await db
      .select()
      .from(schema.statements)
      .where(
        sql`${schema.statements.sourceFactKey} LIKE 'claim:%'
          AND ${schema.statements.statementText} = '[TEST] Duplicate of YAML fact'`
      );

    // Should NOT exist — it was deduplicated
    expect(rows).toHaveLength(0);
  });

  it("uses claim:<id> format for sourceFactKey", async () => {
    const rows = await db
      .select()
      .from(schema.statements)
      .where(
        sql`${schema.statements.sourceFactKey} LIKE 'claim:%'
          AND ${schema.statements.statementText} = '[TEST] Anthropic valuation test'`
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].sourceFactKey).toMatch(/^claim:\d+$/);
  });

  // Cleanup test claims at the end
  it("cleans up test claims", async () => {
    // Remove test claim-sourced statements
    await sqlConn`
      DELETE FROM statement_citations WHERE statement_id IN (
        SELECT id FROM statements WHERE source_fact_key LIKE 'claim:%'
          AND statement_text LIKE '[TEST]%'
      )
    `;
    await sqlConn`
      DELETE FROM statements WHERE source_fact_key LIKE 'claim:%'
        AND statement_text LIKE '[TEST]%'
    `;
    await sqlConn`
      DELETE FROM claim_sources WHERE claim_id IN (
        SELECT id FROM claims WHERE claim_text LIKE '[TEST]%'
      )
    `;
    await sqlConn`DELETE FROM claims WHERE claim_text LIKE '[TEST]%'`;
  });
});
