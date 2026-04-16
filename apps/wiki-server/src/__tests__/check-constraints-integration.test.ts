/**
 * Integration tests — PG CHECK constraints from migration 0183 (QUA-525).
 *
 * These tests require DATABASE_URL to be set. They are skipped otherwise.
 * Run with: pnpm test:integration
 *
 * Each test inserts a row that violates a CHECK constraint and asserts that
 * PG rejects the insert. This verifies the constraints added in migration
 * 0183 actually enforce the invariants, not just that the migration SQL
 * parses.
 *
 * The migration applies all CHECK constraints through a single migration
 * file, so one pass of drop+migrate creates all the tables with their
 * constraints.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as schema from "../schema.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

/**
 * Tables and column pairs covered by migration 0183.
 *
 * Each entry is a live CHECK the migration added. The test inserts a row
 * that violates the constraint; we expect the INSERT to throw with a
 * constraint_violation-shaped error.
 */
const NUMERIC_CONSTRAINTS: Array<{
  constraint: string;
  table: string;
  lowCol: string;
  highCol: string;
  extra?: Record<string, string>; // NOT NULL columns needed to insert
}> = [
  {
    constraint: "chk_fr_raised_range",
    table: "funding_rounds",
    lowCol: "raised_low",
    highCol: "raised_high",
    extra: { company_id: "test-co", name: "Test Round" },
  },
  {
    constraint: "chk_fr_valuation_range",
    table: "funding_rounds",
    lowCol: "valuation_low",
    highCol: "valuation_high",
    extra: { company_id: "test-co", name: "Test Round" },
  },
  {
    constraint: "chk_inv_amount_range",
    table: "investments",
    lowCol: "amount_low",
    highCol: "amount_high",
    extra: { company_id: "test-co", investor_id: "test-inv" },
  },
  {
    constraint: "chk_inv_stake_range",
    table: "investments",
    lowCol: "stake_low",
    highCol: "stake_high",
    extra: { company_id: "test-co", investor_id: "test-inv" },
  },
  {
    constraint: "chk_ep_stake_range",
    table: "equity_positions",
    lowCol: "stake_low",
    highCol: "stake_high",
    extra: { company_id: "test-co", holder_id: "test-holder" },
  },
];

const TEMPORAL_CONSTRAINTS: Array<{
  constraint: string;
  table: string;
  startCol: string;
  endCol: string;
  extra?: Record<string, string>;
}> = [
  {
    constraint: "chk_personnel_date_range",
    table: "personnel",
    startCol: "start_date",
    endCol: "end_date",
    extra: {
      person_id: "test-person",
      organization_id: "test-org",
      role: "CEO",
      role_type: "key-person",
    },
  },
  {
    constraint: "chk_divisions_date_range",
    table: "divisions",
    startCol: "start_date",
    endCol: "end_date",
    extra: { name: "Test Div", division_type: "team" },
  },
  {
    constraint: "chk_ep_validity_range",
    table: "equity_positions",
    startCol: "as_of",
    endCol: "valid_end",
    extra: { company_id: "test-co", holder_id: "test-holder" },
  },
  {
    constraint: "chk_fp_date_range",
    table: "funding_programs",
    startCol: "open_date",
    endCol: "deadline",
    extra: {
      name: "Test Program",
      program_type: "grant-round",
      funder_id: "test-funder",
    },
  },
];

describeWithDb("Integration: QUA-525 CHECK constraints (migration 0183)", () => {
  let sqlConn: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    sqlConn = postgres(DATABASE_URL!, { max: 3 });
    db = drizzle(sqlConn, { schema });
    // Nuke everything and re-migrate. Safer than a curated drop list because
    // migration 0183 touches tables (personnel, divisions, etc.) that aren't
    // in the other integration test files' drop lists.
    await sqlConn`DROP SCHEMA IF EXISTS public CASCADE`;
    await sqlConn`CREATE SCHEMA public`;
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await sqlConn.end();
  });

  describe("numeric range CHECKs reject low > high", () => {
    for (const { constraint, table, lowCol, highCol, extra } of NUMERIC_CONSTRAINTS) {
      it(`${constraint}: rejects ${lowCol} > ${highCol}`, async () => {
        // 10-char id required by the varchar(10) primary key on each table.
        const id = randomId();
        const extraCols = { ...(extra ?? {}) };
        const colNames = [
          "id",
          lowCol,
          highCol,
          ...Object.keys(extraCols),
        ].join(", ");
        const values = [id, "100", "50", ...Object.values(extraCols)];
        const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

        await expect(
          sqlConn.unsafe(
            `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`,
            values,
          ),
        ).rejects.toThrow(/check|constraint/i);
      });

      it(`${constraint}: accepts ${lowCol} <= ${highCol}`, async () => {
        const id = randomId();
        const extraCols = { ...(extra ?? {}) };
        const colNames = [
          "id",
          lowCol,
          highCol,
          ...Object.keys(extraCols),
        ].join(", ");
        const values = [id, "50", "100", ...Object.values(extraCols)];
        const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

        await sqlConn.unsafe(
          `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`,
          values,
        );
        // Cleanup
        await sqlConn.unsafe(
          `DELETE FROM "${table}" WHERE id = $1`,
          [id],
        );
      });
    }
  });

  describe("temporal ordering CHECKs reject start > end", () => {
    for (const { constraint, table, startCol, endCol, extra } of TEMPORAL_CONSTRAINTS) {
      it(`${constraint}: rejects ${startCol} > ${endCol}`, async () => {
        const id = randomId();
        const extraCols = { ...(extra ?? {}) };
        const colNames = [
          "id",
          startCol,
          endCol,
          ...Object.keys(extraCols),
        ].join(", ");
        const values = [id, "2025-01-01", "2020-01-01", ...Object.values(extraCols)];
        const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

        await expect(
          sqlConn.unsafe(
            `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`,
            values,
          ),
        ).rejects.toThrow(/check|constraint/i);
      });

      it(`${constraint}: accepts start <= end`, async () => {
        const id = randomId();
        const extraCols = { ...(extra ?? {}) };
        const colNames = [
          "id",
          startCol,
          endCol,
          ...Object.keys(extraCols),
        ].join(", ");
        const values = [id, "2020-01-01", "2025-01-01", ...Object.values(extraCols)];
        const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

        await sqlConn.unsafe(
          `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`,
          values,
        );
        await sqlConn.unsafe(
          `DELETE FROM "${table}" WHERE id = $1`,
          [id],
        );
      });

      it(`${constraint}: accepts NULL endpoints`, async () => {
        // PG CHECK semantics: NULL comparisons are not-FALSE, so the constraint
        // allows NULL in either column. Sanity-check this holds.
        const id = randomId();
        const extraCols = { ...(extra ?? {}) };
        const colNames = [
          "id",
          startCol,
          ...Object.keys(extraCols),
        ].join(", ");
        const values = [id, "2020-01-01", ...Object.values(extraCols)];
        const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");

        await sqlConn.unsafe(
          `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders})`,
          values,
        );
        await sqlConn.unsafe(
          `DELETE FROM "${table}" WHERE id = $1`,
          [id],
        );
      });
    }
  });
});

function randomId(): string {
  // 10 lowercase alphanumeric chars; matches the varchar(10) PK shape these
  // tables use (and stays below length 11 to avoid accidentally tripping
  // tests that check for sid_ prefixes in display columns).
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 10; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
