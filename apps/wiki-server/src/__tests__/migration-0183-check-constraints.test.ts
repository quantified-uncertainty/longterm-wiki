import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATION_FILE = path.resolve(
  __dirname,
  "../../drizzle/0183_qua_525_numeric_and_temporal_checks.sql",
);

/**
 * Asserts the migration file contains each expected CHECK constraint.
 *
 * This is a schema-drift test: if someone accidentally removes a constraint
 * from the migration or the validator migration target changes, this test
 * fails. It does NOT verify PG-level rejection (that requires a live database
 * and is covered by the constraint's existence — PG enforces it automatically).
 */
describe("migration 0183 — QUA-525 numeric and temporal CHECK constraints", () => {
  const sql = readFileSync(MIGRATION_FILE, "utf-8");

  const expectedConstraints: Array<{
    table: string;
    constraint: string;
    expression: RegExp;
  }> = [
    // Numeric ranges (validate-numeric-ranges replacement)
    {
      table: "funding_rounds",
      constraint: "chk_fr_raised_range",
      expression: /CHECK\s*\(\s*raised_low\s*<=\s*raised_high\s*\)/,
    },
    {
      table: "funding_rounds",
      constraint: "chk_fr_valuation_range",
      expression: /CHECK\s*\(\s*valuation_low\s*<=\s*valuation_high\s*\)/,
    },
    {
      table: "investments",
      constraint: "chk_inv_amount_range",
      expression: /CHECK\s*\(\s*amount_low\s*<=\s*amount_high\s*\)/,
    },
    {
      table: "investments",
      constraint: "chk_inv_stake_range",
      expression: /CHECK\s*\(\s*stake_low\s*<=\s*stake_high\s*\)/,
    },
    {
      table: "equity_positions",
      constraint: "chk_ep_stake_range",
      expression: /CHECK\s*\(\s*stake_low\s*<=\s*stake_high\s*\)/,
    },
    // Temporal ordering (validate-pg-temporal replacement, pair tables only)
    {
      table: "personnel",
      constraint: "chk_personnel_date_range",
      expression: /CHECK\s*\(\s*start_date\s*<=\s*end_date\s*\)/,
    },
    {
      table: "divisions",
      constraint: "chk_divisions_date_range",
      expression: /CHECK\s*\(\s*start_date\s*<=\s*end_date\s*\)/,
    },
    {
      table: "division_personnel",
      constraint: "chk_div_personnel_date_range",
      expression: /CHECK\s*\(\s*start_date\s*<=\s*end_date\s*\)/,
    },
    {
      table: "equity_positions",
      constraint: "chk_ep_validity_range",
      expression: /CHECK\s*\(\s*as_of\s*<=\s*valid_end\s*\)/,
    },
    {
      table: "funding_programs",
      constraint: "chk_fp_date_range",
      expression: /CHECK\s*\(\s*open_date\s*<=\s*deadline\s*\)/,
    },
  ];

  for (const { table, constraint, expression } of expectedConstraints) {
    it(`adds ${constraint} on ${table}`, () => {
      // ADD CONSTRAINT declaration exists for this constraint name.
      expect(sql).toMatch(
        new RegExp(`ADD\\s+CONSTRAINT\\s+${constraint}\\b`),
      );
      // The CHECK expression matches.
      expect(sql).toMatch(expression);
      // The ALTER targets the correct table.
      expect(sql).toMatch(new RegExp(`ALTER\\s+TABLE\\s+"${table}"`));
    });
  }

  it("uses NOT VALID + VALIDATE CONSTRAINT for every constraint", () => {
    // Per docs/agent-rules/database-migrations.md: split DDL into metadata
    // registration (NOT VALID, fast) and validation (VALIDATE CONSTRAINT,
    // non-blocking) to avoid ACCESS EXCLUSIVE contention.
    for (const { constraint } of expectedConstraints) {
      expect(sql, `${constraint} must be declared NOT VALID`).toMatch(
        new RegExp(`ADD\\s+CONSTRAINT\\s+${constraint}[\\s\\S]*?NOT\\s+VALID`),
      );
      expect(sql, `${constraint} must have VALIDATE CONSTRAINT`).toMatch(
        new RegExp(`VALIDATE\\s+CONSTRAINT\\s+${constraint}\\b`),
      );
    }
  });

  it("wraps every ADD CONSTRAINT in a duplicate_object EXCEPTION handler", () => {
    // The DO $$ ... EXCEPTION WHEN duplicate_object ... END $$ block makes
    // the migration idempotent: re-running it when the constraint already
    // exists is a no-op instead of an error.
    for (const { constraint } of expectedConstraints) {
      const pattern = new RegExp(
        `DO\\s*\\$\\$[\\s\\S]*?ADD\\s+CONSTRAINT\\s+${constraint}[\\s\\S]*?EXCEPTION\\s+WHEN\\s+duplicate_object[\\s\\S]*?END\\s*\\$\\$`,
      );
      expect(sql, `${constraint} must be in a duplicate_object handler`).toMatch(
        pattern,
      );
    }
  });
});
