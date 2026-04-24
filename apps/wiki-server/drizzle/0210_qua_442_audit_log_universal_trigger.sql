-- QUA-442: universal PG audit log via generic trigger + SET LOCAL session
-- attribution. Lives under epic QUA-408 (data-model unwind); coordinated
-- to ship before Phase 4b bulk rewrites so the migration writes themselves
-- are captured with session attribution.
--
-- Installs:
--   1. `full_audit_log` table (comprehensive capture; complements the
--       existing `tablebase_audit_log` which stays for richer
--       application-layer entries).
--   2. `audit_trigger_fn()` plpgsql function.
--   3. `apply_audit_trigger(text)` / `remove_audit_trigger(text)` helpers.
--   4. Attaches the trigger to an initial allow-list of TableBase domain
--       tables (~25 tables). Expansion to remaining tables is a one-line
--       follow-up migration per table.
--
-- Source of truth for the procedure bodies lives at
-- apps/wiki-server/drizzle/helpers/audit_log_trigger.sql. That file is kept
-- in sync with the CREATE OR REPLACE bodies below by convention (same
-- pattern as 0199_install_swap_fk_target.sql).
--
-- Caller docs: .claude/rules/audit-log.md.

-- ---- 1. Table ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS full_audit_log (
  id               bigserial PRIMARY KEY,
  table_name       text NOT NULL,
  operation        text NOT NULL,
  old_row          jsonb,
  new_row          jsonb,
  txn_id           bigint,
  session_id       text,
  tool             text,
  application_name text,
  changed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_full_audit_log_table_time
  ON full_audit_log (table_name, changed_at);

CREATE INDEX IF NOT EXISTS idx_full_audit_log_session
  ON full_audit_log (session_id);

CREATE INDEX IF NOT EXISTS idx_full_audit_log_txn
  ON full_audit_log (txn_id);

-- ---- 2. Trigger function -----------------------------------------------
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

-- ---- 3. Helper procedures ----------------------------------------------
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

CREATE OR REPLACE PROCEDURE remove_audit_trigger(target_table text)
LANGUAGE plpgsql AS $proc$
BEGIN
  EXECUTE format(
    'DROP TRIGGER IF EXISTS zz_audit_trigger ON %I',
    target_table
  );
END;
$proc$;

-- ---- 4. Attach to allow-list -------------------------------------------
-- Initial allow-list covers all factory-using TableBase domain tables plus
-- the two flagship non-factory ones (`entities`, `facts`). Deliberately
-- excluded for v1: high-volume time-series (*_snapshots, secondary_market_prices),
-- system/pipeline state (agent_sessions, jobs, groundskeeper_runs, ...),
-- the audit tables themselves, the derived `things` cross-base index, and
-- the claims pipeline (already has its own attribution).
--
-- Expanding: a follow-up migration may call `apply_audit_trigger('<table>')`
-- for any non-listed domain table.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'entities',
    'facts',
    'personnel',
    'grants',
    'investments',
    'funding_rounds',
    'equity_positions',
    'divisions',
    'division_personnel',
    'benchmarks',
    'benchmark_results',
    'publications',
    'research_areas',
    'entity_resources',
    'entity_events',
    'entity_assessments',
    'funding_programs',
    'policy_stakeholders',
    'political_scores',
    'political_votes',
    'political_races',
    'political_offices',
    'campaign_finance',
    'platform_accounts',
    'prediction_market_questions',
    'talent_flows',
    'website_sources',
    'resources'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    CALL apply_audit_trigger(t);
  END LOOP;
END
$$;
