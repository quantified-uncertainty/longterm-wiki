import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATION_FILE = path.resolve(
  __dirname,
  "../../drizzle/0220_qua_764_investments_sid_leak_fix.sql",
);

describe("migration 0220 — QUA-764 investments sid_ leak fix", () => {
  const sql = readFileSync(MIGRATION_FILE, "utf-8");

  /**
   * Find the single UPDATE statement on the given table whose WHERE clause
   * contains the given literal. Splits the SQL into individual UPDATE
   * statements (delimited by `;`) so a regex anchored at the start can't
   * span two adjacent UPDATEs. Used to assert pair-locality so a sid swap
   * between Storyworth/Playground UPDATEs is caught.
   */
  function findUpdateBlock(table: string, whereLiteral: string): string {
    const updateRe = new RegExp(`UPDATE "${table}"[\\s\\S]*?;`, "g");
    const matches = [...sql.matchAll(updateRe)].map((m) => m[0]);
    const candidates = matches.filter((b) => b.includes(whereLiteral));
    expect(
      candidates.length,
      `expected exactly one UPDATE "${table}" block containing ${whereLiteral}, found ${candidates.length}`,
    ).toBe(1);
    return candidates[0];
  }

  it("normalizes sid_Storyworth to entity 'storyworth' (sid_kT85f91plA)", () => {
    const block = findUpdateBlock("investments", `"company_id" = 'sid_Storyworth'`);
    expect(block).toMatch(/"company_entity_id" = 'sid_kT85f91plA'/);
    expect(block).toMatch(/"company_id"\s+= 'storyworth'/);
    expect(block).toMatch(/"company_entity_id" IS NULL/);
    // Cross-pair guard: the playground sid must NOT appear in the storyworth block
    expect(block).not.toMatch(/sid_kh5x0eezrQ/);
    expect(block).not.toMatch(/playground-ai/);
  });

  it("normalizes sid_Playground to entity 'playground-ai' (sid_kh5x0eezrQ)", () => {
    const block = findUpdateBlock("investments", `"company_id" = 'sid_Playground'`);
    expect(block).toMatch(/"company_entity_id" = 'sid_kh5x0eezrQ'/);
    expect(block).toMatch(/"company_id"\s+= 'playground-ai'/);
    expect(block).toMatch(/"company_entity_id" IS NULL/);
    // Cross-pair guard
    expect(block).not.toMatch(/sid_kT85f91plA/);
    expect(block).not.toMatch(/'storyworth'/);
  });

  it("preserves existing display name via COALESCE", () => {
    // Don't blow away a manually-set display name.
    expect(sql).toMatch(
      /COALESCE\("company_display_name", 'StoryWorth'\)/,
    );
    expect(sql).toMatch(
      /COALESCE\("company_display_name", 'Playground'\)/,
    );
  });

  it("rewrites things.parent_thing_id for the 2 normalized rows", () => {
    // The route's toThing writes parent_thing_id = companyId at sync time,
    // so things rows for these investments still point at 'sid_Storyworth' /
    // 'sid_Playground' until we update them. Otherwise the things_search
    // MV refresh propagates the bad sids into search results.
    const storyworthBlock = findUpdateBlock("things", `"parent_thing_id" = 'sid_Storyworth'`);
    expect(storyworthBlock).toMatch(/"parent_thing_id" = 'storyworth'/);
    expect(storyworthBlock).toMatch(/"source_table" = 'investments'/);
    expect(storyworthBlock).not.toMatch(/'playground-ai'/);

    const playgroundBlock = findUpdateBlock("things", `"parent_thing_id" = 'sid_Playground'`);
    expect(playgroundBlock).toMatch(/"parent_thing_id" = 'playground-ai'/);
    expect(playgroundBlock).toMatch(/"source_table" = 'investments'/);
    expect(playgroundBlock).not.toMatch(/'storyworth'/);
  });

  it("documents the trade-off for single-side investor leaks", () => {
    // The migration's header comment must explicitly acknowledge the
    // OR-predicate trade-off (single-side investor-leak rows lose valid
    // company-side data) so future readers don't think it's an oversight.
    expect(sql).toMatch(/single-side investor leaks/);
    expect(sql).toMatch(/Algolia/);
    expect(sql).toMatch(/Rippling/);
  });

  it("has a defensive abort if a normalized row also has an orphan investor sid", () => {
    // Phase 1 normalizes 2 rows; Phase 3's OR-predicate would delete a
    // row where company normalized but investor is also a sid_ orphan.
    // The defensive check converts that scenario from silent data loss
    // into a loud abort.
    expect(sql).toMatch(
      /RAISE EXCEPTION 'QUA-764 aborted: a normalized investment row also has an orphan investor sid/,
    );
    // Defensive check must run AFTER normalization but BEFORE deletion.
    const normalizeIdx = sql.indexOf("'sid_Playground'");
    const checkIdx = sql.indexOf("a normalized investment row also has an orphan");
    const phase2Idx = sql.indexOf('DELETE FROM "things"');
    expect(normalizeIdx).toBeGreaterThan(0);
    expect(checkIdx).toBeGreaterThan(normalizeIdx);
    expect(checkIdx).toBeLessThan(phase2Idx);
  });

  it("notes things_search MV staleness expectation", () => {
    // We deliberately don't REFRESH MATERIALIZED VIEW in the migration —
    // the comment explains why and reassures operators that the hourly
    // groundskeeper refresh will catch up.
    expect(sql).toMatch(/things_search materialized view/);
    expect(sql).toMatch(/groundskeeper REFRESH/);
  });

  it("deletes things rows BEFORE investments rows (FK-safe ordering)", () => {
    const thingsDeleteIdx = sql.indexOf('DELETE FROM "things"');
    const investmentsDeleteIdx = sql.indexOf('DELETE FROM "investments"');
    expect(thingsDeleteIdx).toBeGreaterThan(0);
    expect(investmentsDeleteIdx).toBeGreaterThan(0);
    expect(thingsDeleteIdx).toBeLessThan(investmentsDeleteIdx);
  });

  it("scopes things deletion to source_table = 'investments'", () => {
    expect(sql).toMatch(
      /DELETE FROM "things"[\s\S]+WHERE "source_table" = 'investments'[\s\S]+AND "source_id" IN/,
    );
  });

  it("uses pattern-based DELETE (not hardcoded row ids)", () => {
    // docs/agent-rules/database-migrations.md: never hardcode specific row ids
    // in dedup-style migrations — they miss future rows that match the same
    // shape. Match by predicate (LIKE 'sid_%' AND entity_id IS NULL AND no
    // matching entity).
    const deleteSection = sql.slice(sql.indexOf('DELETE FROM "investments"'));
    expect(deleteSection).toMatch(/"company_id" LIKE 'sid_%'/);
    expect(deleteSection).toMatch(/"investor_id" LIKE 'sid_%'/);
    expect(deleteSection).toMatch(/"company_entity_id" IS NULL/);
    expect(deleteSection).toMatch(/"investor_entity_id" IS NULL/);
    expect(deleteSection).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM "entities" e WHERE e\."stable_id" = i\."company_id"\s*\)/,
    );
    expect(deleteSection).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM "entities" e WHERE e\."stable_id" = i\."investor_id"\s*\)/,
    );
  });

  it("uses RAISE NOTICE for visibility on each phase", () => {
    // Operators reading the deploy log should see what happened.
    expect(sql).toMatch(/RAISE NOTICE 'QUA-764: normalized sid_Storyworth/);
    expect(sql).toMatch(/RAISE NOTICE 'QUA-764: normalized sid_Playground/);
    expect(sql).toMatch(/RAISE NOTICE 'QUA-764: deleted % orphan things row\(s\)/);
    expect(sql).toMatch(/RAISE NOTICE 'QUA-764: deleted % orphan investments row\(s\)/);
  });

  it("does not opt out of the audit trigger (no app.audit_skip)", () => {
    // docs/agent-rules/audit-log.md "When NOT to use it": application
    // bug fixes should be audited. Only bulk migrations (>>10 rows) opt out.
    expect(sql).not.toMatch(/SET LOCAL app\.audit_skip/);
  });

  it("pre-flight aborts loudly if target entities are missing", () => {
    // Better error than a raw FK violation if storyworth or playground-ai
    // ever get dropped from the entities table before migration runs.
    expect(sql).toMatch(
      /RAISE EXCEPTION 'QUA-764 aborted: entity sid_kT85f91plA \(storyworth\) not found/,
    );
    expect(sql).toMatch(
      /RAISE EXCEPTION 'QUA-764 aborted: entity sid_kh5x0eezrQ \(playground-ai\) not found/,
    );
    // Pre-flight must run BEFORE the UPDATEs so we fail before partial state.
    const preflightIdx = sql.indexOf("QUA-764 aborted");
    const updateIdx = sql.indexOf('UPDATE "investments"');
    expect(preflightIdx).toBeLessThan(updateIdx);
  });
});
