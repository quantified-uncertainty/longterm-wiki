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

  it("normalizes sid_Storyworth to entity 'storyworth' (sid_kT85f91plA)", () => {
    expect(sql).toMatch(
      /UPDATE "investments"[\s\S]+SET[\s\S]+"company_entity_id" = 'sid_kT85f91plA'[\s\S]+"company_id"\s+= 'storyworth'[\s\S]+WHERE "company_id" = 'sid_Storyworth'[\s\S]+AND "company_entity_id" IS NULL/,
    );
  });

  it("normalizes sid_Playground to entity 'playground-ai' (sid_kh5x0eezrQ)", () => {
    expect(sql).toMatch(
      /UPDATE "investments"[\s\S]+SET[\s\S]+"company_entity_id" = 'sid_kh5x0eezrQ'[\s\S]+"company_id"\s+= 'playground-ai'[\s\S]+WHERE "company_id" = 'sid_Playground'[\s\S]+AND "company_entity_id" IS NULL/,
    );
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
    expect(sql).toMatch(
      /UPDATE "things"[\s\S]+SET "parent_thing_id" = 'storyworth'[\s\S]+WHERE "source_table" = 'investments'[\s\S]+AND "parent_thing_id" = 'sid_Storyworth'/,
    );
    expect(sql).toMatch(
      /UPDATE "things"[\s\S]+SET "parent_thing_id" = 'playground-ai'[\s\S]+WHERE "source_table" = 'investments'[\s\S]+AND "parent_thing_id" = 'sid_Playground'/,
    );
  });

  it("documents the F3 trade-off (single-side investor leaks)", () => {
    // Reviewer flagged that `OR` between company-leak and investor-leak
    // predicates would delete rows where the company side is valid but
    // the investor is orphan. The migration's header comment must
    // explicitly acknowledge this trade-off so future readers don't think
    // it's an oversight.
    expect(sql).toMatch(/F3 trade-off — single-side investor leaks/);
    expect(sql).toMatch(/Algolia/);
    expect(sql).toMatch(/Rippling/);
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
    // .claude/rules/database-migrations.md: never hardcode specific row ids
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
    // .claude/rules/audit-log.md "When NOT to use it": application
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
