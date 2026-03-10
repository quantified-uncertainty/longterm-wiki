-- Personnel: unified table for key-persons, board-seats, career-history
CREATE TABLE IF NOT EXISTS personnel (
  id VARCHAR(10) PRIMARY KEY,
  person_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  role TEXT NOT NULL,
  role_type TEXT NOT NULL CHECK (role_type IN ('key-person', 'board', 'career')),
  start_date TEXT,
  end_date TEXT,
  is_founder BOOLEAN NOT NULL DEFAULT false,
  appointed_by TEXT,
  background TEXT,
  source TEXT,
  notes TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_personnel_person ON personnel(person_id);
CREATE INDEX IF NOT EXISTS idx_personnel_org ON personnel(organization_id);
CREATE INDEX IF NOT EXISTS idx_personnel_role_type ON personnel(role_type);

-- Grants: major grants, programs, and spending initiatives
CREATE TABLE IF NOT EXISTS grants (
  id VARCHAR(10) PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  amount DOUBLE PRECISION,
  currency TEXT NOT NULL DEFAULT 'USD',
  period TEXT,
  date TEXT,
  status TEXT,
  source TEXT,
  notes TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grants_org ON grants(organization_id);
CREATE INDEX IF NOT EXISTS idx_grants_status ON grants(status);
