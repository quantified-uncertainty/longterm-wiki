SELECT 1; -- Phase D2b: manual migration in scripts/phase-d2b-drop-old-columns.sql
-- Drops all _old text columns from FK tables (Discussion #1497).
-- Must be applied manually via psql after D2a is fully deployed.
