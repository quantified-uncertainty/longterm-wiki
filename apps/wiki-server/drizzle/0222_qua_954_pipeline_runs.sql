-- QUA-954 (parent QUA-943): pipeline_runs table for the machine-write
-- PG-primary transition.
--
-- Tracks per-run lifecycle of generation/improve/etc. pipelines so the
-- coordinator can:
--   * detect dead/stuck runs via heartbeat liveness
--   * attribute writes to the originating pipeline run via the audit trail
--   * surface failure patterns (oscillation, abort reasons) on the
--     /internal/pipeline-runs dashboard.
--
-- The table is intentionally additive — Phase 0d ships only the storage
-- + lifecycle scaffolding. No production caller wires it until Phase 1
-- (QUA-957). Reversibility: trivial (DROP TABLE).
--
-- ## Schema notes
--
-- - `agent_session_id` is `bigint` (FK to `agent_sessions.id` which is
--   bigserial). The QUA-943 RFC §0d spec wrote `uuid` here; the actual
--   `agent_sessions` PK has been bigserial since QUA-406. Using bigint
--   matches the parent column type — uuid would fail at FK creation.
-- - `status` CHECK enumerates the v1 set per the RFC. Per
--   `.claude/rules/database-migrations.md` § "Adding CHECK constraints
--   on enum columns", a follow-up migration may widen this AFTER
--   enumerating prod row distribution; do NOT tighten without first
--   running `SELECT status, count(*) FROM pipeline_runs GROUP BY status`.
-- - `failure_reason` is intentionally untyped (text, not CHECK-enum) for
--   v1: the set of reasons is being discovered through Phase 1 wiring,
--   and a CHECK constraint here would force every code path to redeploy
--   the wiki-server when adding a new reason. A validator is the right
--   layer to enforce known reasons later.
-- - `error_payload` is jsonb so callers can attach arbitrary structured
--   error context (stack snippets, HTTP response bodies, validation
--   errors) without a schema migration per error class.
-- - `followup_actions` is jsonb (default '[]') so callers can record
--   what they did after the run failed (e.g. retried, filed ticket,
--   marked oscillation). Not enforced — the dashboard renders whatever
--   the caller wrote.
--
-- ## Audit trigger (QUA-442)
--
-- Allow-listed per the QUA-943 RFC. Pipeline-run writes are attributed
-- via the universal trigger so cross-table audits (entity write +
-- pipeline_runs lifecycle) line up by `txn_id` / `session_id`.

CREATE TABLE IF NOT EXISTS "pipeline_runs" (
  "run_id"            text PRIMARY KEY,
  "agent_session_id"  bigint REFERENCES "agent_sessions"("id") ON DELETE SET NULL,
  "pipeline_name"     text NOT NULL,
  "entity_id"         text,
  "shape"             text,
  "status"            text NOT NULL,
  "failure_reason"    text,
  "started_at"        timestamptz NOT NULL DEFAULT now(),
  "heartbeat_at"      timestamptz NOT NULL DEFAULT now(),
  "ended_at"          timestamptz,
  "snapshot_path"     text,
  "error_code"        text,
  "error_payload"     jsonb,
  "followup_actions"  jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_pipeline_runs_status" CHECK ("status" IN (
    'running',
    'committed',
    'aborted',
    'oscillation',
    'partial_failure'
  ))
);

-- Dashboard / drilldown queries.
CREATE INDEX IF NOT EXISTS "idx_pipeline_runs_pipeline_name"
  ON "pipeline_runs" ("pipeline_name");

CREATE INDEX IF NOT EXISTS "idx_pipeline_runs_status"
  ON "pipeline_runs" ("status");

-- "Recent runs" listing — typical dashboard query.
CREATE INDEX IF NOT EXISTS "idx_pipeline_runs_started_at"
  ON "pipeline_runs" ("started_at" DESC);

-- "Stuck runs" sweep — find runs whose heartbeat went silent. Partial
-- index keeps it small; only running rows are interesting for liveness.
CREATE INDEX IF NOT EXISTS "idx_pipeline_runs_running_heartbeat"
  ON "pipeline_runs" ("heartbeat_at")
  WHERE "status" = 'running';

CREATE INDEX IF NOT EXISTS "idx_pipeline_runs_entity_id"
  ON "pipeline_runs" ("entity_id");

-- Cross-reference with agent_sessions for the dashboard.
CREATE INDEX IF NOT EXISTS "idx_pipeline_runs_agent_session"
  ON "pipeline_runs" ("agent_session_id");

-- Universal audit trigger (QUA-442).
CALL apply_audit_trigger('pipeline_runs');
