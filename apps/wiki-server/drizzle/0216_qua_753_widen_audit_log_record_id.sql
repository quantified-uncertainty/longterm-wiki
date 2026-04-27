-- QUA-753: widen tablebase_audit_log.record_id from varchar(10) to text.
--
-- The 10-char ceiling was inherited from the canonical stableId pattern
-- (10 alphanumerics, stripped `sid_` prefix). It silently broke for any
-- record_type whose IDs aren't 10-char stableIds:
--
--   - scorecard_snapshots: `<source>-<wave>` (e.g. `fmti-oct-2023`, 13 chars)
--   - scorecard_grades:    `<snap>|<entity>|<dim>` (30+ chars)
--   - any future composite/derived ID
--
-- The factory's auditRecordType hook tries to insert and fails with
-- HTTP 500 on every sync, blocking QUA-748..752 (FMTI, FLI, SaferAI,
-- AILW, Seoul) and likely any other QUA-687 phase whose record IDs
-- aren't 10-char stableIds.
--
-- varchar→text is metadata-only in Postgres (no rewrite). All existing
-- rows have ≤10-char IDs (varchar(10) hard-limited insertions), so the
-- widening is lossless.

ALTER TABLE tablebase_audit_log ALTER COLUMN record_id TYPE text;
