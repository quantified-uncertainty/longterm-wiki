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
-- This one-time backfill retrofits the distinction onto historical rows.
--
-- Predicate: a row is post-QUA-223 historically-swept iff
--   status = 'completed' AND title IS NULL AND summary IS NULL
--   AND completed_at >= '2026-04-11'
-- QUA-223 (PR #4161, merged 2026-04-11) added the hard-fail validation that
-- prevents status='completed' from being set without title+summary. After
-- that date, a row with NULL title+summary must have come from the sweep
-- route (the only remaining writer that bypassed the PATCH validation path).
-- Pre-2026-04-11 rows are left alone because they *could* be legitimate
-- graceful exits that the old PATCH schema accepted without title/summary —
-- we can't reliably distinguish them now.
--
-- Also NULL out completed_at on flipped rows: the old sweep set
-- completed_at=now() which is semantically wrong for a stale session (it
-- never completed). The new sweep does not set completed_at; this backfill
-- matches that new invariant for historical rows.
--
-- Idempotent and bounded (a few hundred rows in prod at most; the column is
-- indexed by status so the query is fast).
UPDATE agent_sessions
   SET status = 'stale',
       completed_at = NULL
 WHERE status = 'completed'
   AND title IS NULL
   AND summary IS NULL
   AND completed_at >= '2026-04-11';
