-- Add computed NUMERIC low/high columns for financial data that may contain ranges.
--
-- funding_rounds: raised/valuation are already NUMERIC (scalar) but we add
-- low/high for consistency and future range support.
--
-- investments: amount is NUMERIC (scalar), stake_acquired is TEXT (may be
-- JSON array like [0.07, 0.15] or a plain number string).
--
-- equity_positions: stake is TEXT (may be JSON array or plain number string).

-- ── funding_rounds ──────────────────────────────────────────────────────

ALTER TABLE funding_rounds ADD COLUMN IF NOT EXISTS raised_low NUMERIC;
ALTER TABLE funding_rounds ADD COLUMN IF NOT EXISTS raised_high NUMERIC;
ALTER TABLE funding_rounds ADD COLUMN IF NOT EXISTS valuation_low NUMERIC;
ALTER TABLE funding_rounds ADD COLUMN IF NOT EXISTS valuation_high NUMERIC;

-- Backfill from existing scalar raised/valuation (low = high = value)
UPDATE funding_rounds
SET raised_low = raised, raised_high = raised
WHERE raised IS NOT NULL AND raised_low IS NULL;

UPDATE funding_rounds
SET valuation_low = valuation, valuation_high = valuation
WHERE valuation IS NOT NULL AND valuation_low IS NULL;

-- ── investments ─────────────────────────────────────────────────────────

ALTER TABLE investments ADD COLUMN IF NOT EXISTS amount_low NUMERIC;
ALTER TABLE investments ADD COLUMN IF NOT EXISTS amount_high NUMERIC;

-- Backfill from existing scalar amount (low = high = value)
UPDATE investments
SET amount_low = amount, amount_high = amount
WHERE amount IS NOT NULL AND amount_low IS NULL;

-- stake_acquired is TEXT; parse range or scalar
ALTER TABLE investments ADD COLUMN IF NOT EXISTS stake_low NUMERIC;
ALTER TABLE investments ADD COLUMN IF NOT EXISTS stake_high NUMERIC;

-- Backfill stake_acquired: JSON array → low/high, plain number → low = high
UPDATE investments
SET
  stake_low = CASE
    WHEN stake_acquired IS NULL THEN NULL
    WHEN stake_acquired LIKE '[%' THEN (stake_acquired::jsonb ->> 0)::numeric
    ELSE stake_acquired::numeric
  END,
  stake_high = CASE
    WHEN stake_acquired IS NULL THEN NULL
    WHEN stake_acquired LIKE '[%' THEN (stake_acquired::jsonb ->> 1)::numeric
    ELSE stake_acquired::numeric
  END
WHERE stake_acquired IS NOT NULL AND stake_low IS NULL;

-- ── equity_positions ────────────────────────────────────────────────────

ALTER TABLE equity_positions ADD COLUMN IF NOT EXISTS stake_low NUMERIC;
ALTER TABLE equity_positions ADD COLUMN IF NOT EXISTS stake_high NUMERIC;

-- Backfill stake: JSON array → low/high, plain number → low = high
UPDATE equity_positions
SET
  stake_low = CASE
    WHEN stake IS NULL THEN NULL
    WHEN stake LIKE '[%' THEN (stake::jsonb ->> 0)::numeric
    ELSE stake::numeric
  END,
  stake_high = CASE
    WHEN stake IS NULL THEN NULL
    WHEN stake LIKE '[%' THEN (stake::jsonb ->> 1)::numeric
    ELSE stake::numeric
  END
WHERE stake IS NOT NULL AND stake_low IS NULL;
