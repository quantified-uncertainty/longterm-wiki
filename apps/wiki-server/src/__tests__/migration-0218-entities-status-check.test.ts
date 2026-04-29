import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { ENTITY_STATUS_VALUES } from "../api-types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATION_FILE = path.resolve(
  __dirname,
  "../../drizzle/0218_qua_526_entities_status_check.sql",
);

/**
 * Schema-drift test for migration 0218 (QUA-526 Phase 4a-2).
 *
 * Asserts the migration declares chk_entities_status with the correct
 * allowed-value set, the NULL allowance, and the NOT VALID + VALIDATE
 * pattern. If the file is edited, this test fails until the regexes are
 * updated to match — the regexes are the canonical contract.
 */
describe("migration 0218 — QUA-526 entities.status CHECK constraint", () => {
  const sql = readFileSync(MIGRATION_FILE, "utf-8");

  it("declares chk_entities_status on entities", () => {
    expect(sql).toMatch(/ALTER\s+TABLE\s+"entities"/);
    expect(sql).toMatch(/ADD\s+CONSTRAINT\s+chk_entities_status\b/);
  });

  it("allows NULL and the four EntityStatus values", () => {
    expect(sql).toMatch(
      /CHECK\s*\(\s*status\s+IS\s+NULL\s+OR\s+status\s+IN\s*\(\s*'stub'\s*,\s*'draft'\s*,\s*'published'\s*,\s*'verified'\s*\)\s*\)/,
    );
  });

  it("CHECK allowed-list matches ENTITY_STATUS_VALUES exactly (parity guard)", () => {
    // QUA-283 lesson: enum drift between Zod and PG CHECK has caused real
    // production incidents. Parse the literal values out of the migration's
    // IN clause and assert set-equality with ENTITY_STATUS_VALUES so the
    // canonical Zod enum and the migration cannot drift independently.
    const inClause = sql.match(
      /status\s+IN\s*\(\s*((?:'[a-z_-]+'\s*,?\s*)+)\)/,
    );
    expect(inClause, "could not parse IN clause from migration").not.toBeNull();
    const migrationValues = (inClause?.[1] ?? "")
      .match(/'([^']+)'/g)
      ?.map((s) => s.slice(1, -1)) ?? [];
    expect([...migrationValues].sort()).toEqual(
      [...ENTITY_STATUS_VALUES].sort(),
    );
  });

  it("uses NOT VALID + VALIDATE CONSTRAINT", () => {
    // Per .claude/rules/database-migrations.md — split DDL into metadata
    // registration (NOT VALID, milliseconds) and validation
    // (VALIDATE CONSTRAINT, SHARE UPDATE EXCLUSIVE) so the ACCESS EXCLUSIVE
    // window stays small.
    expect(sql).toMatch(
      /ADD\s+CONSTRAINT\s+chk_entities_status[\s\S]*?NOT\s+VALID/,
    );
    expect(sql).toMatch(/VALIDATE\s+CONSTRAINT\s+chk_entities_status\b/);
  });

  it("wraps ADD CONSTRAINT in a duplicate_object EXCEPTION handler", () => {
    expect(sql).toMatch(
      /DO\s*\$\$[\s\S]*?ADD\s+CONSTRAINT\s+chk_entities_status[\s\S]*?EXCEPTION\s+WHEN\s+duplicate_object[\s\S]*?END\s*\$\$/,
    );
  });
});
