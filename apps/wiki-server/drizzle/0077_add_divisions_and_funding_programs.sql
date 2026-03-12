-- Divisions: organizational sub-units (funds, teams, departments, labs, program areas)
CREATE TABLE IF NOT EXISTS divisions (
  id VARCHAR(10) PRIMARY KEY,
  slug TEXT UNIQUE,
  parent_org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  division_type TEXT NOT NULL,
  lead TEXT,
  status TEXT,
  start_date TEXT,
  end_date TEXT,
  website TEXT,
  source TEXT,
  notes TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_div_org ON divisions(parent_org_id);
CREATE INDEX IF NOT EXISTS idx_div_slug ON divisions(slug);
CREATE INDEX IF NOT EXISTS idx_div_type ON divisions(division_type);
CREATE INDEX IF NOT EXISTS idx_div_status ON divisions(status);

-- Division personnel: people assigned to specific divisions
CREATE TABLE IF NOT EXISTS division_personnel (
  id VARCHAR(10) PRIMARY KEY,
  division_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  role TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  source TEXT,
  notes TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dp_division ON division_personnel(division_id);
CREATE INDEX IF NOT EXISTS idx_dp_person ON division_personnel(person_id);

-- Funding programs: RFPs, grant rounds, fellowships, prizes, solicitations
CREATE TABLE IF NOT EXISTS funding_programs (
  id VARCHAR(10) PRIMARY KEY,
  org_id TEXT NOT NULL,
  division_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  program_type TEXT NOT NULL,
  total_budget NUMERIC,
  currency TEXT DEFAULT 'USD',
  application_url TEXT,
  open_date TEXT,
  deadline TEXT,
  status TEXT,
  source TEXT,
  notes TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fp_org ON funding_programs(org_id);
CREATE INDEX IF NOT EXISTS idx_fp_division ON funding_programs(division_id);
CREATE INDEX IF NOT EXISTS idx_fp_status ON funding_programs(status);
CREATE INDEX IF NOT EXISTS idx_fp_type ON funding_programs(program_type);
