/**
 * QUA-536 Phase A migration — structural tests.
 *
 * These assert the shape of the manual migration script and its Drizzle
 * no-op pair. The actual DDL behavior is covered by the dry-run harness at
 * `apps/wiki-server/scripts/qua-536-populate-resources-stable-id.sql`
 * itself (pre- and post-conditions), which is exercised when the operator
 * applies the migration via psql with `ON_ERROR_STOP=1`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, "..");

const DRIZZLE_NOOP = join(
  __dirname,
  "..",
  "..",
  "drizzle",
  "0184_qua_536_populate_resources_stable_id.sql",
);
const MANUAL_SCRIPT = join(
  __dirname,
  "..",
  "..",
  "scripts",
  "qua-536-populate-resources-stable-id.sql",
);
const JOURNAL = join(__dirname, "..", "..", "drizzle", "meta", "_journal.json");

describe("QUA-536 Phase A migration structure", () => {
  const drizzleContent = readFileSync(DRIZZLE_NOOP, "utf-8");
  const manualContent = readFileSync(MANUAL_SCRIPT, "utf-8");

  it("Drizzle migration is a SELECT 1 no-op", () => {
    // Drizzle migrator applies every .sql file in the folder. Since the real
    // work happens in the manual script, the Drizzle entry must not do any
    // DDL on its own — lest concurrent readers hit a partial state on
    // autodeploy.
    expect(drizzleContent.replace(/--.*$/gm, "").trim()).toBe("SELECT 1;");
  });

  it("Drizzle migration points at the manual script path", () => {
    // The whole point of the no-op pattern is that the comment tells the
    // operator where the actual work lives. Don't rename the manual script
    // without updating this comment.
    expect(drizzleContent).toContain(
      "apps/wiki-server/scripts/qua-536-populate-resources-stable-id.sql",
    );
  });

  it("Drizzle journal includes a 0184_qua_536 entry with matching idx", () => {
    const journal = JSON.parse(readFileSync(JOURNAL, "utf-8"));
    const entry = journal.entries.find(
      (e: { tag: string }) => e.tag === "0184_qua_536_populate_resources_stable_id",
    );
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(184);
  });

  describe("manual script", () => {
    it("has a BEGIN and a matching COMMIT", () => {
      const beginCount = (manualContent.match(/^BEGIN;/gm) ?? []).length;
      const commitCount = (manualContent.match(/^COMMIT;/gm) ?? []).length;
      expect(beginCount).toBe(1);
      expect(commitCount).toBe(1);
    });

    it("sets lock_timeout and statement_timeout inside the main txn", () => {
      // Any long migration that doesn't bound lock_timeout risks blocking
      // prod traffic for the full statement_timeout. `SET LOCAL` keeps the
      // override scoped to this transaction.
      expect(manualContent).toMatch(/SET LOCAL lock_timeout = '60s'/);
      expect(manualContent).toMatch(/SET LOCAL statement_timeout = '0'/);
    });

    it("asserts NULL rows exist before running", () => {
      // Without this, a re-run on already-populated state would silently
      // succeed instead of failing loudly.
      expect(manualContent).toMatch(/no NULL resources\.stable_id rows/);
    });

    it("asserts zero bare10 rows before running", () => {
      // QUA-503 cleared bare10. If any reappeared, halt and investigate
      // before we potentially mask the drift.
      expect(manualContent).toMatch(/bare10 rows reappeared/);
    });

    it("deletes the test-resource-probe row", () => {
      expect(manualContent).toMatch(/DELETE FROM resources\s+WHERE id = 'test-resource-probe'/);
      expect(manualContent).toMatch(
        /DELETE FROM things\s+WHERE source_table = 'resources' AND source_id = 'test-resource-probe'/,
      );
    });

    it("uses a VOLATILE PL/pgSQL function for sid generation", () => {
      // A scalar subquery would be folded once by the planner and assign
      // every row the same stable_id. The dry-run on 2026-04-16 caught this
      // exact bug; the VOLATILE function fixes it.
      expect(manualContent).toMatch(/qua536_sid_gen/);
      expect(manualContent).toMatch(/LANGUAGE plpgsql VOLATILE/);
    });

    it("sid generator alphabet matches TS generateId()", () => {
      // `packages/factbase/src/ids.ts:45::generateId()` produces
      // "sid_" + 10 chars from A-Z a-z 0-9 (base64url with '-'/'_' replaced).
      // Any drift here would break the downstream invariant that all
      // sid_-prefixed ids match `^sid_[A-Za-z0-9]{10}$`.
      expect(manualContent).toMatch(
        /'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'/,
      );
    });

    it("handles unique_violation with a bounded retry loop", () => {
      // Birthday-paradox collision probability is ~10^-10. If we somehow
      // hit five spurious collisions in a row, that indicates a deeper
      // problem — abort and surface rather than infinite-loop.
      expect(manualContent).toMatch(/EXCEPTION WHEN unique_violation THEN/);
      expect(manualContent).toMatch(/max_attempts int := 5/);
    });

    it("drops FKs on things.id dynamically and asserts the expected set", () => {
      expect(manualContent).toMatch(/qua536_dropped_fks/);
      expect(manualContent).toMatch(/c\.confrelid = 'things'::regclass/);
      expect(manualContent).toMatch(
        /\('things',\s+'parent_thing_id'\),\s+\('qa_page_checks', 'thing_id'\)/,
      );
    });

    it("aligns things.id, things.parent_thing_id, and qa_page_checks.thing_id", () => {
      // Per pre-flight audit: the parent_thing_id and qa_page_checks UPDATEs
      // are defensive (0 rows today), but mandatory so a late-arriving row
      // cannot leak a dangling reference past the re-added FK.
      expect(manualContent).toMatch(/UPDATE things t\s+SET id = r\.stable_id/);
      expect(manualContent).toMatch(/UPDATE things t\s+SET parent_thing_id = r\.stable_id/);
      expect(manualContent).toMatch(/UPDATE qa_page_checks q\s+SET thing_id = r\.stable_id/);
    });

    it("re-adds FKs NOT VALID matching the Drizzle constraint names", () => {
      // The committed Drizzle schema uses these exact names. Mismatched
      // names would leave drizzle-kit generate emitting bogus renames on
      // the next schema export.
      expect(manualContent).toMatch(
        /ADD CONSTRAINT things_parent_thing_id_things_id_fk[\s\S]*NOT VALID/,
      );
      expect(manualContent).toMatch(
        /ADD CONSTRAINT qa_page_checks_thing_id_things_id_fk[\s\S]*NOT VALID/,
      );
    });

    it("verifies zero NULL, correct format, no duplicates, no stale things before COMMIT", () => {
      expect(manualContent).toMatch(/NULL resources\.stable_id rows remain/);
      expect(manualContent).toMatch(/non-canonical stable_id format/);
      expect(manualContent).toMatch(/duplicate stable_id values/);
      expect(manualContent).toMatch(/things rows still mismatch or orphan resources\.stable_id/);
    });

    it("re-checks NULL count between COMMIT and SET NOT NULL (race-window guard)", () => {
      // Between main-txn COMMIT and SET NOT NULL, a concurrent writer with
      // an un-fixed INSERT path could insert a NULL stable_id. Without this
      // guard, SET NOT NULL would fail with a cryptic "null value in column"
      // after the main txn committed irreversibly. The guard catches it
      // early with an actionable message pointing at the root cause.
      expect(manualContent).toMatch(/late_null_count/);
      expect(manualContent).toMatch(
        /NULL stable_id rows appeared between main-txn COMMIT and SET NOT NULL/,
      );
      // Guard must come BEFORE the ALTER TABLE statement (otherwise it's
      // not a guard, just a post-hoc message).
      const guardIdx = manualContent.indexOf("late_null_count");
      const alterIdx = manualContent.indexOf(
        "ALTER TABLE resources ALTER COLUMN stable_id SET NOT NULL",
      );
      expect(guardIdx).toBeGreaterThan(-1);
      expect(alterIdx).toBeGreaterThan(-1);
      expect(guardIdx).toBeLessThan(alterIdx);
    });

    it("runs SET NOT NULL OUTSIDE the main transaction with lock_timeout retry", () => {
      // Inside the main txn, SET NOT NULL deadlocked with concurrent
      // writers on resources (dry-run 2026-04-16). Moving it outside the
      // main txn releases row locks from step 4 before attempting the
      // AccessExclusiveLock, and the retry loop bounds contention.
      const commitIdx = manualContent.indexOf("\nCOMMIT;");
      const setNotNullIdx = manualContent.indexOf("SET NOT NULL");
      expect(commitIdx).toBeGreaterThan(-1);
      expect(setNotNullIdx).toBeGreaterThan(commitIdx);
      expect(manualContent).toMatch(/EXCEPTION WHEN lock_not_available THEN/);
    });

    it("runs VALIDATE CONSTRAINT outside the main transaction", () => {
      const commitIdx = manualContent.indexOf("\nCOMMIT;");
      const validateThingsIdx = manualContent.indexOf(
        "ALTER TABLE things VALIDATE CONSTRAINT",
      );
      const validateQaIdx = manualContent.indexOf(
        "ALTER TABLE qa_page_checks VALIDATE CONSTRAINT",
      );
      expect(validateThingsIdx).toBeGreaterThan(commitIdx);
      expect(validateQaIdx).toBeGreaterThan(commitIdx);
    });

    it("refreshes things_search CONCURRENTLY after commit", () => {
      const commitIdx = manualContent.indexOf("\nCOMMIT;");
      const refreshIdx = manualContent.indexOf(
        "REFRESH MATERIALIZED VIEW CONCURRENTLY things_search",
      );
      expect(refreshIdx).toBeGreaterThan(commitIdx);
    });
  });

  describe("INSERT path stable_id defaulting (regression guards)", () => {
    // After NOT NULL lands on resources.stable_id, every INSERT into resources
    // must provide a stable_id value or the INSERT fails. These guards pin
    // that invariant to the files that insert resources, so a future refactor
    // reverting to `stableId: d.stableId ?? null` fires here instead of in
    // prod at apply time.
    const RESOURCES_ROUTE_PATH = join(
      __dirname,
      "..",
      "routes",
      "wikibase",
      "resources.ts",
    );
    const DATA_SOURCES_PATH = join(
      __dirname,
      "..",
      "routes",
      "tablebase",
      "data-sources.ts",
    );
    const resourcesRoute = readFileSync(RESOURCES_ROUTE_PATH, "utf-8");
    const dataSources = readFileSync(DATA_SOURCES_PATH, "utf-8");

    it("resourceValues() generates stable_id if caller didn't provide", () => {
      // Not `?? null` — that's the pre-QUA-536 bug. Must be `?? generateId()`.
      expect(resourcesRoute).toMatch(/stableId:\s*d\.stableId\s*\?\?\s*generateId\(\)/);
      expect(resourcesRoute).not.toMatch(/stableId:\s*d\.stableId\s*\?\?\s*null\b/);
    });

    it("/suggest raw SQL INSERT includes stable_id column", () => {
      // The raw SQL INSERT used to be `(id, url, type, created_at, updated_at)`.
      // Post-QUA-536 it must include stable_id.
      expect(resourcesRoute).toMatch(
        /INSERT INTO resources\s*\([^)]*stable_id[^)]*\)\s*\n\s*SELECT \* FROM unnest/,
      );
      // And the unnest must include the stable_ids array
      expect(resourcesRoute).toMatch(/\$\{stableIds\}::text\[\]/);
    });

    it("resources.ts imports generateId from @longterm-wiki/factbase", () => {
      expect(resourcesRoute).toMatch(
        /import \{ generateId \} from ["']@longterm-wiki\/factbase["']/,
      );
    });

    it("data-sources.ts tabular resource insert provides stable_id", () => {
      // The data-sources /tabular endpoint creates a resource row. Before
      // QUA-536 it omitted stable_id, relying on the nullable column.
      const insertBlock = dataSources.match(
        /\.insert\(resources\)[\s\S]*?\.returning\([^)]*\);/,
      );
      expect(insertBlock).not.toBeNull();
      expect(insertBlock![0]).toMatch(/stableId:\s*generateId\(\)/);
    });

    it("data-sources.ts imports generateId from @longterm-wiki/factbase", () => {
      expect(dataSources).toMatch(
        /import \{ generateId \} from ["']@longterm-wiki\/factbase["']/,
      );
    });
  });
});
