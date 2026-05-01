-- QUA-696 Phase 7: widen ai_incidents.source CHECK constraint to include
-- 'oecd-aim'.
--
-- Pre-migration enumeration (per docs/agent-rules/database-migrations.md
-- "Adding CHECK constraints on enum columns"):
--
--   $ curl -s "$WIKI_SERVER_URL/api/ai-incidents/stats" -H "Authorization: Bearer $KEY"
--   { "total": 0, "withOrg": 0, "withModel": 0, "bySource": [] }
--
-- The table is empty in prod at the time of this migration (the QUA-693
-- AIID ingest hasn't run yet), so the new CHECK is enforced over zero rows.
-- That makes a plain `DROP CONSTRAINT` + `ADD CONSTRAINT` safe — no
-- `NOT VALID` / `VALIDATE CONSTRAINT` split is required.
--
-- The route's VALID_SOURCES literal in
-- apps/wiki-server/src/routes/tablebase/ai-incidents.ts is updated in the
-- same PR. The validate-ai-incidents-source-enum gate check enforces that
-- the route literal and this migration's `IN (...)` list stay in lockstep
-- so a future addition of (say) 'incident-monitor-3' can't ship route code
-- without also widening the DB constraint.

ALTER TABLE "ai_incidents"
  DROP CONSTRAINT IF EXISTS "chk_ai_incidents_source";

ALTER TABLE "ai_incidents"
  ADD CONSTRAINT "chk_ai_incidents_source"
  CHECK ("source" IN ('mit-aiid', 'oecd-aim'));
