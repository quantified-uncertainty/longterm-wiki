-- Remove duplicate rows from drizzle.__drizzle_migrations.
-- Between March 3-11 2026 the deploy pipeline was broken (workflow triggered
-- on 'production' but deploy conditions checked 'refs/heads/main'), causing
-- migrations to be applied multiple times across different image versions.
-- This left duplicate created_at values that confuse future migration runs.
--
-- Drizzle uses created_at (not hash) for skip/apply decisions. Duplicate
-- created_at values cause migrations to be silently skipped. Group by
-- created_at only and keep the row with the lowest id for each timestamp.

DELETE FROM drizzle.__drizzle_migrations AS m
USING (
  SELECT created_at, MIN(id) AS keep_id
  FROM drizzle.__drizzle_migrations
  GROUP BY created_at
  HAVING COUNT(*) > 1
) AS duplicates
WHERE m.created_at = duplicates.created_at
  AND m.id <> duplicates.keep_id;
