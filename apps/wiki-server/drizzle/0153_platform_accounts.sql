-- Platform accounts: maps wiki entities (people, orgs) to their accounts on
-- external platforms (LessWrong, EA Forum, GitHub, Twitter, Crunchbase, etc.).
-- Enables reverse lookup: given a forum username, find the wiki entity.

CREATE TABLE IF NOT EXISTS platform_accounts (
  id bigserial PRIMARY KEY,
  platform text NOT NULL,
  platform_username text NOT NULL,
  platform_user_id text,
  entity_stable_id text REFERENCES entities(stable_id) ON DELETE SET NULL,
  display_name text,
  profile_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Core constraint: one username per platform = one row
CREATE UNIQUE INDEX IF NOT EXISTS uq_pa_platform_username
  ON platform_accounts (platform, platform_username);

-- Reverse lookup by entity
CREATE INDEX IF NOT EXISTS idx_pa_entity
  ON platform_accounts (entity_stable_id);

-- Lookup by platform internal ID
CREATE INDEX IF NOT EXISTS idx_pa_platform_user_id
  ON platform_accounts (platform, platform_user_id)
  WHERE platform_user_id IS NOT NULL;
