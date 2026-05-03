/**
 * Static-shape tests for migration 0224 (QUA-942) — evidence_locator JSONB.
 *
 * The migration adds a single nullable JSONB column with a partial GIN index.
 * Goals checked here:
 *   - Column added to the right table, with the right type, nullable
 *   - Index exists, partial (NOT NULL filter), GIN — so we don't pay storage
 *     for the millions of NULL rows in the table today
 *   - Migration is idempotent (IF NOT EXISTS) so replay is safe
 *   - Journal entry exists with the right tag (catches "forgot to update
 *     journal" — known foot-gun in this repo)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATION_FILE = path.resolve(
  __dirname,
  "../../drizzle/0224_qua_942_evidence_locator.sql",
);
const JOURNAL_FILE = path.resolve(
  __dirname,
  "../../drizzle/meta/_journal.json",
);

describe("migration 0224 — QUA-942 evidence_locator", () => {
  const sql = readFileSync(MIGRATION_FILE, "utf-8");

  it("adds evidence_locator JSONB column to source_check_evidence", () => {
    expect(sql).toMatch(
      /ALTER TABLE\s+"?source_check_evidence"?\s+ADD COLUMN\s+IF NOT EXISTS\s+"?evidence_locator"?\s+jsonb/i,
    );
    // Must be nullable — we never want to backfill a JSONB locator on rows
    // that were written before page-addressable evidence was a thing.
    // Check only the ALTER TABLE statement (CREATE INDEX has IS NOT NULL in
    // its WHERE clause, which is fine).
    const alterMatch = sql.match(/ALTER TABLE[^;]*evidence_locator[^;]*;/i);
    expect(alterMatch, "ALTER TABLE for evidence_locator should be present").toBeTruthy();
    expect(alterMatch![0]).not.toMatch(/NOT NULL/i);
  });

  it("creates a partial GIN index for non-null locators", () => {
    expect(sql).toMatch(
      /CREATE INDEX\s+IF NOT EXISTS\s+"?idx_sce_evidence_locator"?[\s\S]*?USING gin/i,
    );
    expect(sql).toMatch(/WHERE\s+"?evidence_locator"?\s+IS NOT NULL/i);
  });

  it("uses IF NOT EXISTS for idempotency on replay", () => {
    expect(sql).toMatch(/ADD COLUMN\s+IF NOT EXISTS/i);
    expect(sql).toMatch(/CREATE INDEX\s+IF NOT EXISTS/i);
  });

  it("is registered in the drizzle journal", () => {
    const journal = JSON.parse(readFileSync(JOURNAL_FILE, "utf-8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const entry = journal.entries.find((e) => e.idx === 224);
    expect(entry).toBeDefined();
    expect(entry?.tag).toBe("0224_qua_942_evidence_locator");
  });
});
