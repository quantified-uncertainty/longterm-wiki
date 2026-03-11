-- Remove duplicate rows from drizzle.__drizzle_migrations.
-- Between March 3-11 2026 the deploy pipeline was broken (workflow triggered
-- on 'production' but deploy conditions checked 'refs/heads/main'), causing
-- migrations to be applied multiple times across different image versions.
-- This left duplicate hash+created_at pairs that could confuse future
-- migration runs.
--
-- Keep only the row with the lowest id for each (hash, created_at) pair.

DELETE FROM drizzle.__drizzle_migrations
WHERE id NOT IN (
  SELECT MIN(id)
  FROM drizzle.__drizzle_migrations
  GROUP BY hash, created_at
);
