import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATION_FILE = path.resolve(
  __dirname,
  "../../drizzle/0221_qua_956_policy_stakeholders_natural_key.sql",
);

describe("migration 0221 — QUA-956 policy_stakeholders natural-key + UNIQUE", () => {
  const sql = readFileSync(MIGRATION_FILE, "utf-8");

  it("uses dynamic ROW_NUMBER dedup, not hardcoded ids", () => {
    // The 2026-03-28 funding_programs outage was caused by hardcoding two
    // duplicate ids and missing a third. Insist on the ROW_NUMBER pattern
    // so the migration handles every duplicate that exists at apply time.
    expect(sql).toMatch(
      /ROW_NUMBER\(\)\s+OVER\s*\(\s*PARTITION BY policy_entity_id, stakeholder_display_name/,
    );
    // ORDER BY created_at, id (deterministic tiebreaker for same-timestamp rows)
    expect(sql).toMatch(/ORDER BY created_at, id/);
    // No hardcoded id literals (sid_-prefixed or 10-char) in DELETE WHERE clauses.
    expect(sql).not.toMatch(/DELETE FROM policy_stakeholders\s*WHERE id\s*=\s*'[^']/);
  });

  it("cleans up paired things rows before deleting the policy_stakeholders rows", () => {
    // Order matters — if we delete policy_stakeholders first, things rows
    // pointing to deleted source_ids hang around and the things_search MV
    // still surfaces them.
    const thingsDeleteIdx = sql.search(
      /DELETE FROM things[\s\S]*?source_table\s*=\s*'policy_stakeholders'/,
    );
    const stakeholdersDeleteIdx = sql.search(
      /DELETE FROM policy_stakeholders\s+WHERE id IN/,
    );
    expect(thingsDeleteIdx).toBeGreaterThan(-1);
    expect(stakeholdersDeleteIdx).toBeGreaterThan(-1);
    expect(thingsDeleteIdx).toBeLessThan(stakeholdersDeleteIdx);
  });

  it("creates the natural-key UNIQUE index after dedup", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_stakeholders_natural_key\s+ON policy_stakeholders \(policy_entity_id, stakeholder_display_name\)/,
    );
    // The CREATE INDEX must come after the DELETE so dedup runs first; if
    // the order flips, CREATE INDEX fails on the existing duplicates.
    const deleteIdx = sql.search(
      /DELETE FROM policy_stakeholders\s+WHERE id IN/,
    );
    const createIdx = sql.search(/CREATE UNIQUE INDEX/);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeLessThan(createIdx);
  });

  it("uses IF NOT EXISTS for idempotency on replay", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/);
  });

  it("does not skip the audit trigger (this is not a multi-million-row rewrite)", () => {
    // 234 dupe rows + ~238 things rows = ~472 audit entries — small enough
    // that the trigger overhead doesn't matter and the audit trail is
    // useful for forensics. `app.audit_skip` is only for bulk migrations.
    expect(sql).not.toMatch(/audit_skip/);
  });
});
