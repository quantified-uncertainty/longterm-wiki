import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATION_FILE = path.resolve(
  __dirname,
  "../../drizzle/0198_qua_492_facts_fact_id_check.sql",
);

/**
 * Schema-drift test: asserts the migration SQL contains the expected
 * CHECK constraint. It does NOT verify PG-level rejection (PG enforces
 * the constraint automatically once applied).
 */
describe("migration 0198 — QUA-492 facts.fact_id CHECK constraint", () => {
  const sql = readFileSync(MIGRATION_FILE, "utf-8");

  it("declares ADD CONSTRAINT chk_facts_fact_id_format on facts", () => {
    expect(sql).toMatch(/ALTER\s+TABLE\s+"facts"/);
    expect(sql).toMatch(/ADD\s+CONSTRAINT\s+chk_facts_fact_id_format\b/);
  });

  it("uses the canonical ^f_[A-Za-z0-9]{10}$ regex", () => {
    // The strict {10} form matches generateFactId() output exactly.
    // {8,} is only used by /internal/data-quality drift detection.
    expect(sql).toMatch(
      /CHECK\s*\(\s*fact_id\s*~\s*'\^f_\[A-Za-z0-9\]\{10\}\$'\s*\)/,
    );
  });

  it("uses NOT VALID + VALIDATE CONSTRAINT (avoids long ACCESS EXCLUSIVE lock)", () => {
    // Per .claude/rules/database-migrations.md: split DDL into metadata
    // registration (NOT VALID, fast) and validation (VALIDATE CONSTRAINT,
    // non-blocking) to avoid holding ACCESS EXCLUSIVE during a full row scan.
    expect(sql).toMatch(
      /ADD\s+CONSTRAINT\s+chk_facts_fact_id_format[\s\S]*?NOT\s+VALID/,
    );
    expect(sql).toMatch(
      /VALIDATE\s+CONSTRAINT\s+chk_facts_fact_id_format\b/,
    );
  });

  it("wraps ADD CONSTRAINT in a duplicate_object EXCEPTION handler (idempotent)", () => {
    // DO $$ ... EXCEPTION WHEN duplicate_object ... END $$ makes the
    // migration safe to re-run if interrupted partway through.
    expect(sql).toMatch(
      /DO\s*\$\$[\s\S]*?ADD\s+CONSTRAINT\s+chk_facts_fact_id_format[\s\S]*?EXCEPTION\s+WHEN\s+duplicate_object[\s\S]*?END\s*\$\$/,
    );
  });
});
