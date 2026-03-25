-- political_races: tracks political races relevant to AI policy
CREATE TABLE IF NOT EXISTS "political_races" (
  "id" varchar(10) PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "race_type" text NOT NULL,
  "party" text,
  "level" text NOT NULL,
  "state" text,
  "district" text,
  "election_date" text,
  "status" text NOT NULL DEFAULT 'upcoming',
  "outcome" text,
  "outcome_details" text,
  "ai_angle" text,
  "ai_angle_summary" text,
  "policy_entity_id" text REFERENCES "entities"("stable_id") ON DELETE SET NULL,
  "measure_title" text,
  "measure_description" text,
  "source" text,
  "notes" text,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_pr_status" ON "political_races" ("status");
CREATE INDEX IF NOT EXISTS "idx_pr_state" ON "political_races" ("state");
CREATE INDEX IF NOT EXISTS "idx_pr_level" ON "political_races" ("level");
CREATE INDEX IF NOT EXISTS "idx_pr_race_type" ON "political_races" ("race_type");
CREATE INDEX IF NOT EXISTS "idx_pr_election_date" ON "political_races" ("election_date");
CREATE INDEX IF NOT EXISTS "idx_pr_policy_entity" ON "political_races" ("policy_entity_id");

-- race_candidates: candidates in political races with PAC backing info
CREATE TABLE IF NOT EXISTS "race_candidates" (
  "id" varchar(10) PRIMARY KEY NOT NULL,
  "race_id" varchar(10) NOT NULL REFERENCES "political_races"("id") ON DELETE CASCADE,
  "candidate_entity_id" text REFERENCES "entities"("stable_id") ON DELETE SET NULL,
  "candidate_display_name" text NOT NULL,
  "is_incumbent" boolean NOT NULL DEFAULT false,
  "is_winner" boolean NOT NULL DEFAULT false,
  "vote_share" numeric,
  "status" text NOT NULL DEFAULT 'running',
  "pac_entity_id" text REFERENCES "entities"("stable_id") ON DELETE SET NULL,
  "pac_display_name" text,
  "pac_amount" numeric,
  "pac_position" text,
  "party" text,
  "endorsements" text,
  "ai_stance" text,
  "source" text,
  "notes" text,
  "synced_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_rc_race" ON "race_candidates" ("race_id");
CREATE INDEX IF NOT EXISTS "idx_rc_candidate_entity" ON "race_candidates" ("candidate_entity_id");
CREATE INDEX IF NOT EXISTS "idx_rc_pac_entity" ON "race_candidates" ("pac_entity_id");
CREATE INDEX IF NOT EXISTS "idx_rc_status" ON "race_candidates" ("status");
CREATE INDEX IF NOT EXISTS "idx_rc_ai_stance" ON "race_candidates" ("ai_stance");
