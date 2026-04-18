-- QUA-221: backfill `agent_sessions.status='stale'` for rows that were
-- previously swept to `completed` without a graceful exit.
--
-- Context: prior to this PR, /api/agent-sessions/sweep flipped stale active
-- sessions directly to status='completed' with no title/summary backfill. That
-- masked the 0% fill-rate problem QUA-221 set out to fix — every swept session
-- *looked* completed in dashboards while having no metadata. The sweep now
-- emits status='stale' so `completed` is reserved for graceful-exit sessions
-- (where the SessionEnd hook ran `crux sys session-finalize` and populated
-- title+summary via PATCH validation).
--
-- This one-time backfill retrofits the distinction onto historical rows so
-- that the completion-rate metric in /internal/agent-activity and in
-- monitoring.ts::fetchAgentActivity becomes immediately meaningful after this
-- PR deploys instead of decaying toward accuracy over weeks.
--
-- A row is considered historically-swept (not graceful) when:
--   status = 'completed' AND title IS NULL AND summary IS NULL
-- Graceful-exit rows populate both fields via the hook, so this predicate
-- cannot misclassify a genuinely-completed row.
--
-- Idempotent and bounded (a few hundred rows in prod at most; the column is
-- indexed by status so the query is fast).
UPDATE agent_sessions
   SET status = 'stale'
 WHERE status = 'completed'
   AND title IS NULL
   AND summary IS NULL;
