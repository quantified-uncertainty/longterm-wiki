-- QUA-525: Migrate validate-numeric-ranges and validate-pg-temporal to PG CHECK constraints.
--
-- These two validators enforced invariants that are fundamentally schema-level:
--   - validate-numeric-ranges checked low <= high on funding_rounds (raised, valuation),
--     investments (amount, stake), and equity_positions (stake)
--   - validate-pg-temporal checked start_date <= end_date on personnel, divisions,
--     division_personnel, equity_positions (asOf/validEnd), and funding_programs
--     (openDate/deadline)
--
-- After this migration, both validators and their gate entries are deleted.
-- The invariants are enforced at PG write time instead of at PR time.
--
-- ## Prod enumeration (2026-04-16, per .claude/rules/database-migrations.md)
--
-- Numeric ranges: 0 violations across 175 rows (funding_rounds=90, investments=72,
--   equity_positions=13).
-- Temporal ordering: 0 violations across 7,389 rows in 9 tables.
-- Temporal format: 10 warnings (9 funding_programs.deadline="Rolling", 1
--   funding_rounds.date="1993-1997") — these do not affect the ordering check
--   because text lexicographic comparison treats "Rolling" as sorting after any
--   YYYY date, so the CHECK passes. The format check is dropped with the validator
--   (not portable to a simple PG CHECK due to legitimate non-date values).
--
-- ## Safety
--
-- All target tables are small (largest is personnel with ~1000 rows). `NOT VALID`
-- + `VALIDATE CONSTRAINT` is not strictly necessary at this size but is used for
-- consistency with the pattern in .claude/rules/database-migrations.md and to be
-- future-proof as tables grow.
--
-- Each ADD CONSTRAINT is wrapped in a DO block with EXCEPTION handling so the
-- migration is idempotent — safe to re-run if interrupted partway through.
--
-- The CHECK expressions use `<=` (not `<`) to allow equal values (e.g., a
-- single-day range where start == end). NULL values pass implicitly because
-- PG CHECK treats NULL comparisons as not-false.

-- ---------------------------------------------------------------------------
-- Numeric range constraints (from validate-numeric-ranges)
-- ---------------------------------------------------------------------------

-- 1. funding_rounds.raised_low <= raised_high
DO $$ BEGIN
  ALTER TABLE "funding_rounds"
    ADD CONSTRAINT chk_fr_raised_range
    CHECK (raised_low <= raised_high) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "funding_rounds" VALIDATE CONSTRAINT chk_fr_raised_range;

-- 2. funding_rounds.valuation_low <= valuation_high
DO $$ BEGIN
  ALTER TABLE "funding_rounds"
    ADD CONSTRAINT chk_fr_valuation_range
    CHECK (valuation_low <= valuation_high) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "funding_rounds" VALIDATE CONSTRAINT chk_fr_valuation_range;

-- 3. investments.amount_low <= amount_high
DO $$ BEGIN
  ALTER TABLE "investments"
    ADD CONSTRAINT chk_inv_amount_range
    CHECK (amount_low <= amount_high) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "investments" VALIDATE CONSTRAINT chk_inv_amount_range;

-- 4. investments.stake_low <= stake_high
DO $$ BEGIN
  ALTER TABLE "investments"
    ADD CONSTRAINT chk_inv_stake_range
    CHECK (stake_low <= stake_high) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "investments" VALIDATE CONSTRAINT chk_inv_stake_range;

-- 5. equity_positions.stake_low <= stake_high
DO $$ BEGIN
  ALTER TABLE "equity_positions"
    ADD CONSTRAINT chk_ep_stake_range
    CHECK (stake_low <= stake_high) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "equity_positions" VALIDATE CONSTRAINT chk_ep_stake_range;

-- ---------------------------------------------------------------------------
-- Temporal ordering constraints (from validate-pg-temporal, pair tables only)
-- ---------------------------------------------------------------------------
--
-- Single-date tables (funding_rounds.date, investments.date, grants.date,
-- benchmarks.introduced_date, benchmark_results.date) have no pair to compare,
-- so they are not covered here. Format validation for those fields is dropped
-- with the validator.

-- 6. personnel.start_date <= end_date
DO $$ BEGIN
  ALTER TABLE "personnel"
    ADD CONSTRAINT chk_personnel_date_range
    CHECK (start_date <= end_date) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "personnel" VALIDATE CONSTRAINT chk_personnel_date_range;

-- 7. divisions.start_date <= end_date
DO $$ BEGIN
  ALTER TABLE "divisions"
    ADD CONSTRAINT chk_divisions_date_range
    CHECK (start_date <= end_date) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "divisions" VALIDATE CONSTRAINT chk_divisions_date_range;

-- 8. division_personnel.start_date <= end_date
DO $$ BEGIN
  ALTER TABLE "division_personnel"
    ADD CONSTRAINT chk_div_personnel_date_range
    CHECK (start_date <= end_date) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "division_personnel" VALIDATE CONSTRAINT chk_div_personnel_date_range;

-- 9. equity_positions.as_of <= valid_end
DO $$ BEGIN
  ALTER TABLE "equity_positions"
    ADD CONSTRAINT chk_ep_validity_range
    CHECK (as_of <= valid_end) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "equity_positions" VALIDATE CONSTRAINT chk_ep_validity_range;

-- 10. funding_programs.open_date <= deadline
DO $$ BEGIN
  ALTER TABLE "funding_programs"
    ADD CONSTRAINT chk_fp_date_range
    CHECK (open_date <= deadline) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE "funding_programs" VALIDATE CONSTRAINT chk_fp_date_range;
