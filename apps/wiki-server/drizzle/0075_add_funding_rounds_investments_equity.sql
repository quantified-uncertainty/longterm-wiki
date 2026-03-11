-- Funding rounds: equity and strategic investment rounds for companies
CREATE TABLE IF NOT EXISTS funding_rounds (
  id VARCHAR(10) PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  date TEXT,
  raised NUMERIC,
  valuation NUMERIC,
  instrument TEXT,
  lead_investor TEXT,
  source TEXT,
  notes TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fr_company ON funding_rounds(company_id);
CREATE INDEX IF NOT EXISTS idx_fr_date ON funding_rounds(date);

-- Investments: investor participation in funding rounds
CREATE TABLE IF NOT EXISTS investments (
  id VARCHAR(10) PRIMARY KEY,
  company_id TEXT NOT NULL,
  investor_id TEXT NOT NULL,
  round_name TEXT,
  date TEXT,
  amount NUMERIC,
  stake_acquired TEXT,
  instrument TEXT,
  role TEXT,
  conditions TEXT,
  source TEXT,
  notes TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inv_company ON investments(company_id);
CREATE INDEX IF NOT EXISTS idx_inv_investor ON investments(investor_id);
CREATE INDEX IF NOT EXISTS idx_inv_date ON investments(date);

-- Equity positions: current/historical equity ownership stakes
CREATE TABLE IF NOT EXISTS equity_positions (
  id VARCHAR(10) PRIMARY KEY,
  company_id TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  stake TEXT,
  source TEXT,
  notes TEXT,
  as_of TEXT,
  valid_end TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ep_company ON equity_positions(company_id);
CREATE INDEX IF NOT EXISTS idx_ep_holder ON equity_positions(holder_id);
