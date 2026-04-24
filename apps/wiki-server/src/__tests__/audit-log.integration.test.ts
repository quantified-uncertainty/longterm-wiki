/**
 * Integration tests — universal PG audit log (QUA-442 / migration 0204).
 *
 * Verifies the full round trip: an attached trigger writes to
 * `full_audit_log` on INSERT/UPDATE/DELETE, populates before/after JSONB,
 * reads session+tool attribution from GUCs set via `SET LOCAL`, and
 * honors the `app.audit_skip` escape hatch.
 *
 * Requires DATABASE_URL; otherwise skipped (same convention as
 * swap-fk-target-integration.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
const describeWithDb = DATABASE_URL ? describe : describe.skip;

const SCHEMA = "audit_log_test";

describeWithDb("full_audit_log trigger (migration 0204 / QUA-442)", () => {
  let sqlConn: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sqlConn = postgres(DATABASE_URL!, { max: 2 });

    // Sanity check: the trigger function and helper must be installed.
    const fnExists = await sqlConn<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'audit_trigger_fn' AND n.nspname = 'public'
      ) AS exists
    `;
    if (!fnExists[0]?.exists) {
      throw new Error(
        "audit_trigger_fn not installed — run migrations up to 0204 before this test.",
      );
    }
    const procExists = await sqlConn<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'apply_audit_trigger' AND n.nspname = 'public'
      ) AS exists
    `;
    if (!procExists[0]?.exists) {
      throw new Error(
        "apply_audit_trigger procedure not installed — run migrations up to 0204.",
      );
    }

    await sqlConn.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sqlConn.unsafe(`CREATE SCHEMA ${SCHEMA}`);
  });

  afterAll(async () => {
    await sqlConn.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sqlConn.end();
  });

  beforeEach(async () => {
    // Use a test table in the public schema so the trigger function (which
    // INSERTs into public.full_audit_log) can see the foreign table's OID.
    // Because apply_audit_trigger scopes to current_schema(), we'll SET
    // search_path explicitly in each test run.
    await sqlConn.unsafe(`DROP TABLE IF EXISTS public.audit_test_widgets CASCADE`);
    await sqlConn.unsafe(`
      CREATE TABLE public.audit_test_widgets (
        id   text PRIMARY KEY,
        name text NOT NULL,
        qty  integer
      )
    `);
    await sqlConn.unsafe(`CALL apply_audit_trigger('audit_test_widgets')`);

    // Clear audit rows from any prior run on this fixture.
    await sqlConn.unsafe(`DELETE FROM full_audit_log WHERE table_name = 'audit_test_widgets'`);
  });

  async function readAuditRows() {
    return await sqlConn<
      Array<{
        id: string;
        table_name: string;
        operation: string;
        old_row: Record<string, unknown> | null;
        new_row: Record<string, unknown> | null;
        txn_id: string | null;
        session_id: string | null;
        tool: string | null;
        application_name: string | null;
      }>
    >`SELECT id::text, table_name, operation, old_row, new_row,
              txn_id::text, session_id, tool, application_name
      FROM full_audit_log
      WHERE table_name = 'audit_test_widgets'
      ORDER BY id ASC`;
  }

  it("records INSERT with new_row populated and old_row NULL", async () => {
    await sqlConn`INSERT INTO audit_test_widgets (id, name, qty) VALUES ('w1', 'widget-one', 42)`;
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe("INSERT");
    expect(rows[0].old_row).toBeNull();
    expect(rows[0].new_row).toMatchObject({ id: "w1", name: "widget-one", qty: 42 });
  });

  it("records UPDATE with both old_row and new_row populated", async () => {
    await sqlConn`INSERT INTO audit_test_widgets (id, name, qty) VALUES ('w1', 'orig', 1)`;
    await sqlConn`UPDATE audit_test_widgets SET name = 'renamed', qty = 2 WHERE id = 'w1'`;
    const rows = await readAuditRows();
    expect(rows).toHaveLength(2);
    const update = rows.find((r) => r.operation === "UPDATE");
    expect(update).toBeDefined();
    expect(update?.old_row).toMatchObject({ id: "w1", name: "orig", qty: 1 });
    expect(update?.new_row).toMatchObject({ id: "w1", name: "renamed", qty: 2 });
  });

  it("records DELETE with old_row populated and new_row NULL", async () => {
    await sqlConn`INSERT INTO audit_test_widgets (id, name, qty) VALUES ('w1', 'doomed', 1)`;
    await sqlConn`DELETE FROM audit_test_widgets WHERE id = 'w1'`;
    const rows = await readAuditRows();
    expect(rows).toHaveLength(2);
    const del = rows.find((r) => r.operation === "DELETE");
    expect(del).toBeDefined();
    expect(del?.old_row).toMatchObject({ id: "w1", name: "doomed", qty: 1 });
    expect(del?.new_row).toBeNull();
  });

  it("captures session_id and tool from SET LOCAL GUCs", async () => {
    // SET LOCAL scopes to a transaction, so wrap the write in BEGIN/COMMIT.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- postgres.js `TransactionSql` drops the tagged-template call signature via `Omit<>`; see db.ts::beginTransaction for the production workaround. Tests only need the runtime callable.
    await sqlConn.begin(async (tx: any) => {
      await tx`SELECT set_config('app.agent_session_id', '12345', true)`;
      await tx`SELECT set_config('app.agent_tool', 'tb.scaffold', true)`;
      await tx`INSERT INTO audit_test_widgets (id, name, qty) VALUES ('w1', 'tracked', 1)`;
    });
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("12345");
    expect(rows[0].tool).toBe("tb.scaffold");
  });

  it("records NULL attribution when GUCs are unset", async () => {
    await sqlConn`INSERT INTO audit_test_widgets (id, name, qty) VALUES ('w1', 'no-attr', 1)`;
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBeNull();
    expect(rows[0].tool).toBeNull();
  });

  it("skips audit rows when app.audit_skip = 'true'", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- postgres.js `TransactionSql` drops the tagged-template call signature via `Omit<>`; see db.ts::beginTransaction for the production workaround. Tests only need the runtime callable.
    await sqlConn.begin(async (tx: any) => {
      await tx`SELECT set_config('app.audit_skip', 'true', true)`;
      await tx`INSERT INTO audit_test_widgets (id, name, qty) VALUES ('w1', 'silent', 1)`;
      await tx`UPDATE audit_test_widgets SET qty = 2 WHERE id = 'w1'`;
      await tx`DELETE FROM audit_test_widgets WHERE id = 'w1'`;
    });
    const rows = await readAuditRows();
    expect(rows).toHaveLength(0);
  });

  it("groups multi-row writes in one transaction under a single txn_id", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- postgres.js `TransactionSql` drops the tagged-template call signature via `Omit<>`; see db.ts::beginTransaction for the production workaround. Tests only need the runtime callable.
    await sqlConn.begin(async (tx: any) => {
      await tx`INSERT INTO audit_test_widgets (id, name, qty) VALUES ('a', 'x', 1)`;
      await tx`INSERT INTO audit_test_widgets (id, name, qty) VALUES ('b', 'y', 2)`;
      await tx`INSERT INTO audit_test_widgets (id, name, qty) VALUES ('c', 'z', 3)`;
    });
    const rows = await readAuditRows();
    expect(rows).toHaveLength(3);
    const uniqueTxns = new Set(rows.map((r) => r.txn_id));
    expect(uniqueTxns.size).toBe(1);
  });

  it("re-attaching the trigger is idempotent", async () => {
    // Two back-to-back attaches should leave exactly one trigger and writes
    // should produce one audit row, not two.
    await sqlConn.unsafe(`CALL apply_audit_trigger('audit_test_widgets')`);
    await sqlConn.unsafe(`CALL apply_audit_trigger('audit_test_widgets')`);
    await sqlConn`INSERT INTO audit_test_widgets (id, name, qty) VALUES ('w1', 'once', 1)`;
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
  });

  it("remove_audit_trigger stops the capture", async () => {
    await sqlConn.unsafe(`CALL remove_audit_trigger('audit_test_widgets')`);
    await sqlConn`INSERT INTO audit_test_widgets (id, name, qty) VALUES ('w1', 'gone', 1)`;
    const rows = await readAuditRows();
    expect(rows).toHaveLength(0);
  });

  it("apply_audit_trigger silently skips missing tables", async () => {
    // No row should be inserted (the function returns early with NOTICE).
    await expect(
      sqlConn.unsafe(`CALL apply_audit_trigger('does_not_exist_anywhere')`),
    ).resolves.toBeDefined();
  });

  it("treats empty-string GUCs as NULL in the audit row", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- postgres.js `TransactionSql` drops the tagged-template call signature via `Omit<>`; see db.ts::beginTransaction for the production workaround. Tests only need the runtime callable.
    await sqlConn.begin(async (tx: any) => {
      await tx`SELECT set_config('app.agent_session_id', '', true)`;
      await tx`SELECT set_config('app.agent_tool', '', true)`;
      await tx`INSERT INTO audit_test_widgets (id, name, qty) VALUES ('w1', 'empty', 1)`;
    });
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBeNull();
    expect(rows[0].tool).toBeNull();
  });
});
