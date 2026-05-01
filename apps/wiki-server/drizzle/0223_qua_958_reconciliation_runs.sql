-- QUA-958 (parent QUA-943): reconciliation_runs table — heartbeat record for
-- the daily PG-vs-YAML reconciliation cron.
--
-- Mirrors the `auto_update_runs` pattern (idea: same QUA-31 mistake of
-- "no Linear comment is ambiguous between zero divergence vs cron broken"
-- shouldn't repeat). Each cron tick writes a row regardless of outcome so
-- the health-gate sentinel can ask "did we even run?" not just
-- "is anyone reporting divergence?".
--
-- Red-team finding #4 (≥10 non-empty diffs precondition for Phase 4):
-- `non_empty_diffs_observed` records how many diffs hit policies that
-- actually have YAML stakeholders. Reconciliation hits 0 trivially across
-- the 112 (of 151) policies with no `stakeholders:` block. Phase 4 cutover
-- (QUA-960) is gated on a rolling-window count of ≥10 non-empty diffs
-- observed AND zero divergence on those — proves the dual-write actually
-- fired before declaring it ready.
--
-- Reversibility: trivial (DROP TABLE).

CREATE TABLE IF NOT EXISTS "reconciliation_runs" (
  "id"                          bigserial PRIMARY KEY,
  -- Domain the run scans. `policy_stakeholders` is the only canary in QUA-958;
  -- future domains (org employees, etc.) extend by adding new values here. No
  -- CHECK constraint until enum stability — see database-migrations.md.
  "domain"                      text NOT NULL,
  "trigger"                     text NOT NULL,
  "started_at"                  timestamptz NOT NULL DEFAULT now(),
  "completed_at"                timestamptz,
  -- Counts: total entities scanned, those with non-empty YAML data
  -- (the ones whose absence in PG would be a real bug), divergences
  -- detected, and the subset of divergences on non-empty entities.
  "entities_scanned"            integer,
  "entities_non_empty"          integer,
  "diffs_detected"              integer,
  "non_empty_diffs_observed"    integer,
  -- Free-form structured details (per-entity diff list, etc.) for the
  -- Linear comment + dashboard drilldown. jsonb so we don't migrate per
  -- new field.
  "details_json"                jsonb,
  -- Failure capture for the heartbeat-on-broken-cron case.
  "error_code"                  text,
  "error_message"               text,
  "created_at"                  timestamptz NOT NULL DEFAULT now()
);

-- Idempotency guard. The cron's GitHub Actions step records `started_at`
-- once; if the workflow retries it shouldn't insert a second row for the
-- same minute. Mirrors auto_update_runs.0041 pattern.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_reconciliation_runs_domain_started_unique"
  ON "reconciliation_runs" ("domain", "started_at");

-- "Latest run for domain X" — the health-gate sentinel queries this.
CREATE INDEX IF NOT EXISTS "idx_reconciliation_runs_domain_started"
  ON "reconciliation_runs" ("domain", "started_at" DESC);

-- "Did the cron run today?" rollup — used by the heartbeat dashboard.
CREATE INDEX IF NOT EXISTS "idx_reconciliation_runs_completed_at"
  ON "reconciliation_runs" ("completed_at" DESC);

-- Universal audit trigger (QUA-442). Reconciliation rows are
-- operational telemetry; allow-listing is consistent with auto_update_runs.
CALL apply_audit_trigger('reconciliation_runs');
