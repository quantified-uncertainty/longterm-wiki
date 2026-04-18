-- QUA-221: retrofit status='stale' onto historical rows that were previously
-- swept to 'completed' without a graceful exit (pre-PR sweep behavior).
--
-- Predicate rationale: from 2026-04-11 onward, QUA-223's hard-fail validation
-- prevents the PATCH route from setting status='completed' without title+summary,
-- so any post-cutoff row with NULL title+summary must have come from the sweep.
-- Pre-cutoff rows are left alone — the old PATCH schema accepted them.
--
-- completed_at cleared: the old sweep set it; stale rows never completed.
--
-- Idempotent (re-runs match 0 rows since flipped rows are now 'stale').
UPDATE agent_sessions
   SET status = 'stale',
       completed_at = NULL
 WHERE status = 'completed'
   AND title IS NULL
   AND summary IS NULL
   AND completed_at >= '2026-04-11';
