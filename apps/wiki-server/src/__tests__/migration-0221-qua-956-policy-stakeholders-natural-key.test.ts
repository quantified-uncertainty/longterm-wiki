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
    // No hardcoded id literals in DELETE WHERE clauses.
    expect(sql).not.toMatch(/DELETE FROM policy_stakeholders\s*WHERE id\s*=\s*'[^']/);
  });

  it("merges non-null enrichment fields into the canonical row before deleting duplicates", () => {
    // Earliest-keep silently loses 62 stakeholder_entity_id resolutions on
    // prod (verified 2026-04-30) — the canonical (earliest) row was
    // typically inserted before resolution; the resolved sid_ landed on a
    // later duplicate. The merge step recovers that data via COALESCE.
    expect(sql).toMatch(
      /UPDATE policy_stakeholders\s+ps\s+SET[\s\S]*?stakeholder_entity_id\s*=\s*COALESCE\(ps\.stakeholder_entity_id,\s*m\.merged_eid\)/,
    );
    expect(sql).toMatch(
      /source\s*=\s*COALESCE\(NULLIF\(ps\.source,\s*''\),\s*m\.merged_source\)/,
    );
    expect(sql).toMatch(
      /reason\s*=\s*COALESCE\(NULLIF\(ps\.reason,\s*''\),\s*m\.merged_reason\)/,
    );
    // The merge MUST happen before the DELETE — otherwise the source rows
    // for the merge are gone before COALESCE can read them.
    const updateIdx = sql.search(/UPDATE policy_stakeholders\s+ps\s+SET/);
    const deleteIdx = sql.search(
      /DELETE FROM policy_stakeholders\s+WHERE id IN/,
    );
    expect(updateIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeLessThan(deleteIdx);
  });

  it("merge picks the freshest non-null value (non-null first, then created_at DESC)", () => {
    // The "non-null first" sentinel ensures NULLs are sorted last; among
    // non-nulls we want the most recent (likely the most-recently-resolved).
    // If we picked the OLDEST non-null, we might keep a value that has
    // since been corrected.
    expect(sql).toMatch(
      /array_agg\(stakeholder_entity_id ORDER BY \(stakeholder_entity_id IS NULL\),\s*created_at DESC, id DESC\)\s+FILTER \(WHERE stakeholder_entity_id IS NOT NULL\)/,
    );
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
    // ~234 dupe deletes + ~136 canonical UPDATEs → ≤370 audit_trigger_fn
    // rows in full_audit_log. (`things` is not on the audit allow-list — see
    // `.claude/rules/audit-log.md` — so the things cleanup doesn't add to
    // the count.) Small enough that the trigger overhead doesn't matter
    // and the audit trail is useful for forensics. `app.audit_skip` is
    // only for bulk migrations (millions of rows).
    expect(sql).not.toMatch(/audit_skip/);
  });
});
