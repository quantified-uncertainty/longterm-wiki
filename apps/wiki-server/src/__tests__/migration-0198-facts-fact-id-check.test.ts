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
    // DO $$ ... EXCEPTION WHEN duplicate_object ... END $$ makes a manual
    // re-apply (outside Drizzle) a no-op. Drizzle itself tracks applied
    // migrations and won't re-run this file.
    expect(sql).toMatch(
      /DO\s*\$\$[\s\S]*?ADD\s+CONSTRAINT\s+chk_facts_fact_id_format[\s\S]*?EXCEPTION\s+WHEN\s+duplicate_object[\s\S]*?END\s*\$\$/,
    );
  });

  it("sets lock_timeout to tolerate in-progress things_search REFRESH", () => {
    // The things_search MV REFRESH (hourly job, 180s statement_timeout)
    // holds ACCESS SHARE on facts. Without an extended lock_timeout the
    // migration would fail at the default 60s. See migration 0190 +
    // routes/operational/things-search-refresh.ts and the QUA-302 postmortem.
    expect(sql).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'180000'/);
  });
});

describe("facts.fact_id CHECK regex semantics (behavior)", () => {
  // PG regex operator `~` uses POSIX syntax, but [A-Za-z0-9]{10} is
  // portable across POSIX and ECMAScript. Testing in JS gives us
  // defense-in-depth without a live PG.
  const CHECK_RE = /^f_[A-Za-z0-9]{10}$/;

  it("accepts the canonical generateFactId() output shape", () => {
    expect(CHECK_RE.test("f_a3Kf2rZ9mQ")).toBe(true); // mixed case + digit
    expect(CHECK_RE.test("f_1234567890")).toBe(true); // all digits
    expect(CHECK_RE.test("f_abcdefghij")).toBe(true); // all lowercase
    expect(CHECK_RE.test("f_ABCDEFGHIJ")).toBe(true); // all uppercase
  });

  it("rejects non-canonical shapes that used to be in prod", () => {
    expect(CHECK_RE.test("00mxokmZmg")).toBe(false); // bare 10-char legacy
    expect(CHECK_RE.test("abcdef12")).toBe(false); // 8-char hex legacy
    expect(CHECK_RE.test("abcdef1234567890")).toBe(false); // 16-char hex
    expect(CHECK_RE.test("kb-abcdef1234567890")).toBe(false); // kb-prefixed
  });

  it("rejects length mismatches (off-by-one guards)", () => {
    expect(CHECK_RE.test("f_abc123456")).toBe(false); // 9 chars after f_
    expect(CHECK_RE.test("f_abcd12345")).toBe(false); // 10 chars but only 10 total
    expect(CHECK_RE.test("f_abcdefghij1")).toBe(false); // 11 chars after f_
  });

  it("rejects wrong prefix / no prefix / empty", () => {
    expect(CHECK_RE.test("sid_abc1234567")).toBe(false); // sid_ not f_
    expect(CHECK_RE.test("f-abc1234567")).toBe(false); // hyphen not underscore
    expect(CHECK_RE.test("F_abc1234567")).toBe(false); // uppercase prefix
    expect(CHECK_RE.test("")).toBe(false);
  });

  it("rejects non-alphanumeric chars (excludes what base64url would leak)", () => {
    // base64url can emit `-` or `_`; generateFactId() replaces them but
    // verify the constraint would reject if the replacement ever broke.
    expect(CHECK_RE.test("f_abc-defghi")).toBe(false); // hyphen
    expect(CHECK_RE.test("f_abc_defghi")).toBe(false); // underscore
    expect(CHECK_RE.test("f_abc defghi")).toBe(false); // space
    expect(CHECK_RE.test("f_abcdefghi!")).toBe(false); // punctuation
  });
});
