/**
 * Integration tests — swap_fk_target() PL/pgSQL helper from QUA-600
 * (migration 0199).
 *
 * These tests require DATABASE_URL to be set. They are skipped otherwise.
 * Run with: pnpm test:integration (or `pnpm test` with DATABASE_URL set).
 *
 * We create a dedicated test schema (`swap_fk_target_test`) with throwaway
 * parent/child tables so the tests don't touch anything in the real public
 * schema. Each test resets the tables.
 *
 * What we verify here are the invariants the helper promises to the migration
 * template, not general PG behavior. The defects the helper exists to prevent
 * (PR #4460 / #4466) are the primary test targets:
 *   - Orphan check is NOT EXISTS against the parent, not a format heuristic.
 *   - UPDATE doesn't overwrite a real FK with NULL when parent.to_col is NULL.
 *   - Replay is a no-op.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const SCHEMA = "swap_fk_target_test";

describeWithDb("swap_fk_target() (migration 0199 / QUA-600)", () => {
  let sqlConn: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sqlConn = postgres(DATABASE_URL!, { max: 2 });

    // Sanity-check the procedure exists in the DB we're talking to. If this
    // assertion fails, the DB wasn't migrated up to 0199 — bail early with a
    // useful error rather than letting every test fail opaquely.
    const procExists = await sqlConn<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'swap_fk_target' AND n.nspname = 'public'
      ) AS exists
    `;
    if (!procExists[0]?.exists) {
      throw new Error(
        "swap_fk_target procedure not installed — run migrations up to 0199 before this test.",
      );
    }

    // Clean slate every run.
    await sqlConn.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sqlConn.unsafe(`CREATE SCHEMA ${SCHEMA}`);
  });

  afterAll(async () => {
    await sqlConn.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sqlConn.end();
  });

  /**
   * Reset to the canonical two-table fixture used by most tests:
   *   parent(id text PK, stable_id text UNIQUE)  -- id = legacy, stable_id = canonical
   *   child(id serial PK, parent_id text FK → parent(id) ON DELETE <policy>)
   *
   * Tests set up their own rows after calling this.
   */
  async function resetFixture(onDelete = "CASCADE") {
    await sqlConn.unsafe(`SET search_path TO ${SCHEMA}, public`);
    await sqlConn.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.child CASCADE`);
    await sqlConn.unsafe(`DROP TABLE IF EXISTS ${SCHEMA}.parent CASCADE`);
    await sqlConn.unsafe(`
      CREATE TABLE ${SCHEMA}.parent (
        id text PRIMARY KEY,
        stable_id text UNIQUE
      )
    `);
    await sqlConn.unsafe(`
      CREATE TABLE ${SCHEMA}.child (
        id serial PRIMARY KEY,
        parent_id text REFERENCES ${SCHEMA}.parent(id) ON DELETE ${onDelete}
      )
    `);
  }

  async function callHelper(opts: {
    onDelete?: string;
    useNotValid?: boolean;
    newConstraintName?: string;
  } = {}) {
    const { onDelete = "CASCADE", useNotValid = false, newConstraintName = null } = opts;
    // Procedures are invoked via CALL; parameter order matters because
    // postgres.js doesn't support the `=>` named-args syntax via tagged
    // templates, so we pass positionally.
    await sqlConn.unsafe(
      `CALL swap_fk_target($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        "child",
        "parent_id",
        "parent",
        "id",
        "stable_id",
        onDelete,
        useNotValid,
        newConstraintName,
      ],
    );
  }

  beforeEach(async () => {
    // Scope every test to the isolated schema so CALL … against 'child' /
    // 'parent' resolves to the fixture tables, not the production ones.
    await sqlConn.unsafe(`SET search_path TO ${SCHEMA}, public`);
  });

  it("rewrites child.parent_id from parent.id → parent.stable_id and swaps the FK", async () => {
    await resetFixture("CASCADE");
    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.parent (id, stable_id) VALUES
        ('legacy-a', 'sid_AAAAAAAAAA'),
        ('legacy-b', 'sid_BBBBBBBBBB')
    `);
    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.child (parent_id) VALUES ('legacy-a'), ('legacy-b'), ('legacy-a')
    `);

    await callHelper({ onDelete: "CASCADE" });

    const rows = await sqlConn<{ parent_id: string }[]>`
      SELECT parent_id FROM ${sqlConn(SCHEMA)}.child ORDER BY id
    `;
    expect(rows.map((r) => r.parent_id)).toEqual([
      "sid_AAAAAAAAAA",
      "sid_BBBBBBBBBB",
      "sid_AAAAAAAAAA",
    ]);

    const fks = await sqlConn<{ constraint_name: string; delete_rule: string }[]>`
      SELECT tc.constraint_name, rc.delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON tc.constraint_name = rc.constraint_name
      WHERE tc.table_schema = ${SCHEMA}
        AND tc.table_name = 'child'
        AND tc.constraint_type = 'FOREIGN KEY'
    `;
    expect(fks.length).toBe(1);
    expect(fks[0]?.constraint_name).toBe("child_parent_id_parent_stable_id_fk");
    expect(fks[0]?.delete_rule).toBe("CASCADE");
  });

  it("raises with an actionable message on orphaned rows (the #4466 defect)", async () => {
    await resetFixture("SET NULL");
    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.parent (id, stable_id) VALUES ('legacy-a', 'sid_AAAAAAAAAA')
    `);
    // Insert an orphan: parent_id value that doesn't match any parent.id and
    // won't map to any parent.stable_id after backfill. This is exactly the
    // shape the NOT EXISTS orphan check catches — a NOT LIKE 'sid_%' heuristic
    // would not, because 'ghost' isn't sid_-prefixed either.
    //
    // We have to bypass the existing FK to insert the orphan, so drop the FK
    // first. The helper will rediscover there's no FK, skip step 1, try to
    // add the new one, and trip the orphan check.
    await sqlConn.unsafe(`
      ALTER TABLE ${SCHEMA}.child DROP CONSTRAINT child_parent_id_fkey
    `);
    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.child (parent_id) VALUES ('legacy-a'), ('ghost')
    `);

    await expect(callHelper({ onDelete: "SET NULL" })).rejects.toThrow(
      /orphan row\(s\) remain.*ghost|orphan row\(s\) remain/i,
    );

    // FK should NOT have been added — orphan check is a hard stop.
    const fks = await sqlConn<{ constraint_name: string }[]>`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_schema = ${SCHEMA} AND table_name = 'child' AND constraint_type = 'FOREIGN KEY'
    `;
    expect(fks.length).toBe(0);
  });

  it("does not overwrite a child row to NULL when parent.stable_id is NULL (the #4466 null-guard defect)", async () => {
    // Scenario: parent row exists, but its stable_id is NULL (Phase A
    // backfill missed it). A naïve UPDATE without the NULL guard would
    // rewrite child.parent_id = NULL and then the orphan check or the
    // subsequent ADD CONSTRAINT would still pass (NULL isn't an orphan).
    // Silent corruption. The NULL guard in the UPDATE leaves the row alone,
    // the orphan check trips on legacy-a, CALL raises, and the whole
    // transaction rolls back.
    //
    // We assert on two things: (a) the procedure raises on orphans, and
    // (b) the child row with the NULL-parent.to_col is NOT NULL after the
    // rollback — the operator can see the real data and fix the parent row.
    await resetFixture("SET NULL");
    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.parent (id, stable_id) VALUES
        ('legacy-a', NULL),
        ('legacy-b', 'sid_BBBBBBBBBB')
    `);
    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.child (parent_id) VALUES ('legacy-a'), ('legacy-b')
    `);

    await expect(callHelper({ onDelete: "SET NULL" })).rejects.toThrow(/orphan row/i);

    // The CALL is one transaction and the RAISE rolls it back, so both
    // child rows are observed in their pre-call state. Critically, the
    // 'legacy-a' row is 'legacy-a' — NOT NULL. A defective helper without
    // the parent.to_col IS NOT NULL guard on the UPDATE would have set
    // this to NULL before the orphan check, and the NULL wouldn't have
    // rolled back cleanly if the ADD CONSTRAINT had succeeded.
    const rows = await sqlConn<{ parent_id: string | null }[]>`
      SELECT parent_id FROM ${sqlConn(SCHEMA)}.child ORDER BY id
    `;
    expect(rows[0]?.parent_id).toBe("legacy-a");
    expect(rows[0]?.parent_id).not.toBeNull();
    expect(rows[1]?.parent_id).toBe("legacy-b");
  });

  it("is idempotent on replay (second call is a no-op)", async () => {
    await resetFixture("CASCADE");
    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.parent (id, stable_id) VALUES ('legacy-a', 'sid_AAAAAAAAAA')
    `);
    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.child (parent_id) VALUES ('legacy-a'), ('legacy-a')
    `);

    await callHelper({ onDelete: "CASCADE" });
    // Second call must not throw, must not drop the new FK, must not rewrite.
    await callHelper({ onDelete: "CASCADE" });

    const rows = await sqlConn<{ parent_id: string }[]>`
      SELECT parent_id FROM ${sqlConn(SCHEMA)}.child ORDER BY id
    `;
    expect(rows.map((r) => r.parent_id)).toEqual(["sid_AAAAAAAAAA", "sid_AAAAAAAAAA"]);

    const fks = await sqlConn<{ constraint_name: string }[]>`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_schema = ${SCHEMA} AND table_name = 'child' AND constraint_type = 'FOREIGN KEY'
    `;
    expect(fks.length).toBe(1);
    expect(fks[0]?.constraint_name).toBe("child_parent_id_parent_stable_id_fk");
  });

  it("leaves NULL parent_id values untouched (nullable FK support)", async () => {
    await resetFixture("SET NULL");
    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.parent (id, stable_id) VALUES ('legacy-a', 'sid_AAAAAAAAAA')
    `);
    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.child (parent_id) VALUES ('legacy-a'), (NULL), (NULL)
    `);

    await callHelper({ onDelete: "SET NULL" });

    const rows = await sqlConn<{ parent_id: string | null }[]>`
      SELECT parent_id FROM ${sqlConn(SCHEMA)}.child ORDER BY id
    `;
    expect(rows.map((r) => r.parent_id)).toEqual(["sid_AAAAAAAAAA", null, null]);
  });

  it("use_not_valid=true adds the constraint as NOT VALID then VALIDATEs it", async () => {
    await resetFixture("CASCADE");
    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.parent (id, stable_id) VALUES ('legacy-a', 'sid_AAAAAAAAAA')
    `);
    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.child (parent_id) VALUES ('legacy-a')
    `);

    await callHelper({ onDelete: "CASCADE", useNotValid: true });

    // After VALIDATE CONSTRAINT, pg_constraint.convalidated = true.
    // We query pg_constraint (not information_schema, which doesn't expose
    // the NOT VALID flag) on the new FK name.
    const constraints = await sqlConn<{ convalidated: boolean }[]>`
      SELECT c.convalidated
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.conname = 'child_parent_id_parent_stable_id_fk'
        AND t.relname = 'child'
        AND n.nspname = ${SCHEMA}
    `;
    expect(constraints.length).toBe(1);
    expect(constraints[0]?.convalidated).toBe(true);
  });

  it("rejects unknown on_delete values before touching the table", async () => {
    await resetFixture("CASCADE");
    await expect(
      sqlConn.unsafe(
        `CALL swap_fk_target($1, $2, $3, $4, $5, $6, $7, $8)`,
        ["child", "parent_id", "parent", "id", "stable_id", "EXPLODE", false, null],
      ),
    ).rejects.toThrow(/on_delete must be one of/i);
  });

  it("drops multiple old FK constraints on the same column (enumerated via pg_catalog)", async () => {
    // Some tables carry both the Drizzle-generated FK name and a leftover
    // postgres-default fkey from an earlier schema. The helper should drop
    // both, not require the caller to know their names.
    await resetFixture("CASCADE");
    // Add a second FK on parent_id pointing at parent.id.
    await sqlConn.unsafe(`
      ALTER TABLE ${SCHEMA}.child
      ADD CONSTRAINT child_parent_id_secondary_fk
      FOREIGN KEY (parent_id) REFERENCES ${SCHEMA}.parent(id) ON DELETE CASCADE
    `);

    const before = await sqlConn<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM information_schema.referential_constraints rc
      JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
      WHERE tc.table_schema = ${SCHEMA} AND tc.table_name = 'child'
    `;
    expect(Number(before[0]?.count ?? 0)).toBe(2);

    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.parent (id, stable_id) VALUES ('legacy-a', 'sid_AAAAAAAAAA')
    `);
    await sqlConn.unsafe(`INSERT INTO ${SCHEMA}.child (parent_id) VALUES ('legacy-a')`);

    await callHelper({ onDelete: "CASCADE" });

    const after = await sqlConn<{ constraint_name: string }[]>`
      SELECT tc.constraint_name
      FROM information_schema.table_constraints tc
      WHERE tc.table_schema = ${SCHEMA}
        AND tc.table_name = 'child'
        AND tc.constraint_type = 'FOREIGN KEY'
    `;
    expect(after.map((r) => r.constraint_name)).toEqual([
      "child_parent_id_parent_stable_id_fk",
    ]);
  });

  it("honors a custom new_constraint_name override", async () => {
    await resetFixture("CASCADE");
    await sqlConn.unsafe(`
      INSERT INTO ${SCHEMA}.parent (id, stable_id) VALUES ('legacy-a', 'sid_AAAAAAAAAA')
    `);
    await sqlConn.unsafe(`INSERT INTO ${SCHEMA}.child (parent_id) VALUES ('legacy-a')`);

    await callHelper({ onDelete: "CASCADE", newConstraintName: "custom_fk_name" });

    const fks = await sqlConn<{ constraint_name: string }[]>`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_schema = ${SCHEMA} AND table_name = 'child' AND constraint_type = 'FOREIGN KEY'
    `;
    expect(fks.map((r) => r.constraint_name)).toEqual(["custom_fk_name"]);
  });
});
