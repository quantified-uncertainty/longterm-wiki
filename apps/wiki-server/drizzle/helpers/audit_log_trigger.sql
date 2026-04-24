-- QUA-442: universal audit-log trigger function.
--
-- Source of truth for the procedure body. Landed via a thin install
-- migration (see 0204_qua_442_audit_log_universal_trigger.sql); any change
-- to the function must be re-landed via a new CREATE OR REPLACE migration
-- because Drizzle doesn't rescan helpers/.
--
-- Caller docs: .claude/rules/audit-log.md and
-- .claude/rules/database-migrations.md § "Audit-log escape hatch".

-- The trigger function. Fires AFTER INSERT, UPDATE, DELETE on every table it's
-- attached to. Writes a single row to `full_audit_log` with before/after
-- state as JSONB plus GUC-sourced session attribution.
--
-- Opt-out: set `app.audit_skip = 'true'` (SET LOCAL for per-transaction,
-- SET SESSION for the duration of a psql/Drizzle connection) to bypass the
-- insert entirely. Used by bulk backfill migrations that would otherwise
-- produce millions of audit rows for no investigative value.
--
-- Fail-open: every current_setting() uses the `missing_ok = true` second
-- argument so the function never errors on a never-set GUC — the audit row
-- simply records NULL session/tool/application_name. An audit-trigger that
-- can break writes is worse than one that records fewer fields.
CREATE OR REPLACE FUNCTION audit_trigger_fn() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_session_id       text;
  v_tool             text;
  v_application_name text;
  v_skip             text;
BEGIN
  v_skip := current_setting('app.audit_skip', true);
  IF v_skip = 'true' OR v_skip = 'on' OR v_skip = '1' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_session_id       := current_setting('app.agent_session_id', true);
  v_tool             := current_setting('app.agent_tool', true);
  v_application_name := current_setting('application_name', true);

  -- Treat empty strings as NULL so filters can use IS NULL uniformly.
  IF v_session_id       = '' THEN v_session_id       := NULL; END IF;
  IF v_tool             = '' THEN v_tool             := NULL; END IF;
  IF v_application_name = '' THEN v_application_name := NULL; END IF;

  INSERT INTO full_audit_log (
    table_name, operation,
    old_row, new_row, txn_id,
    session_id, tool, application_name, changed_at
  ) VALUES (
    TG_TABLE_NAME, TG_OP,
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END,
    txid_current(),
    v_session_id, v_tool, v_application_name,
    now()
  );

  RETURN COALESCE(NEW, OLD);
END;
$fn$;

-- Attach or re-attach the audit trigger to a single table. Idempotent.
--
-- Uses a well-known trigger name (`zz_audit_trigger`) so a second call is a
-- DROP-then-CREATE; the leading `zz_` keeps this trigger firing last, after
-- any domain-specific triggers (e.g. search_vector refresh). Callers pass
-- unqualified table names; the helper scopes to current_schema().
CREATE OR REPLACE PROCEDURE apply_audit_trigger(target_table text)
LANGUAGE plpgsql AS $proc$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name   = target_table
      AND table_type   = 'BASE TABLE'
  ) THEN
    RAISE NOTICE 'apply_audit_trigger: table % not found in schema %; skipping',
      target_table, current_schema();
    RETURN;
  END IF;

  EXECUTE format(
    'DROP TRIGGER IF EXISTS zz_audit_trigger ON %I',
    target_table
  );
  EXECUTE format(
    'CREATE TRIGGER zz_audit_trigger AFTER INSERT OR UPDATE OR DELETE ON %I '
    || 'FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn()',
    target_table
  );
  RAISE NOTICE 'apply_audit_trigger: attached to %', target_table;
END;
$proc$;

-- Detach the audit trigger from a single table. Idempotent no-op if the
-- trigger isn't present.
CREATE OR REPLACE PROCEDURE remove_audit_trigger(target_table text)
LANGUAGE plpgsql AS $proc$
BEGIN
  EXECUTE format(
    'DROP TRIGGER IF EXISTS zz_audit_trigger ON %I',
    target_table
  );
END;
$proc$;
