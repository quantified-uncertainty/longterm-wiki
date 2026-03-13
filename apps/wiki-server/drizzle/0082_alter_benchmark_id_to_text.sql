-- Fix benchmark ID columns: original migration 0080 used VARCHAR(10) but schema
-- expects TEXT. ALTER TYPE to match the Drizzle schema definition.
-- VARCHAR(n) → TEXT is a safe no-rewrite cast in PostgreSQL (both use varlena storage).
ALTER TABLE benchmarks ALTER COLUMN id TYPE TEXT;
ALTER TABLE benchmark_results ALTER COLUMN benchmark_id TYPE TEXT;
