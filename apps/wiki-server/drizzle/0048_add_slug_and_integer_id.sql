-- Phase 4a: Originally added slug/integer_id columns to wiki_pages + FK tables.
-- Replaced with no-op because the DDL requires ACCESS EXCLUSIVE locks that
-- deadlock with the running production server during rolling deploys.
-- The actual schema changes are in 0049_add_slug_and_integer_id_safe.sql
-- which uses IF NOT EXISTS for idempotent, retry-safe execution.
SELECT 1;
