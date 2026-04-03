-- Campaign Finance: FEC data on fundraising and spending by politicians
CREATE TABLE IF NOT EXISTS "campaign_finance" (
  "id" varchar(10) PRIMARY KEY NOT NULL,
  "politician_entity_id" varchar(40) REFERENCES "entities"("stable_id") ON DELETE SET NULL,
  "politician_display_name" varchar(200),
  "cycle" integer NOT NULL,
  "total_raised" numeric(14,2),
  "total_spent" numeric(14,2),
  "cash_on_hand" numeric(14,2),
  "individual_contributions" numeric(14,2),
  "pac_contributions" numeric(14,2),
  "small_donor_contributions" numeric(14,2),
  "self_funding" numeric(14,2),
  "party" varchar(20),
  "office_type" varchar(30),
  "state" varchar(5),
  "district" varchar(10),
  "fec_candidate_id" varchar(20),
  "source_url" text,
  "data_as_of" date,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_campfin_politician" ON "campaign_finance" ("politician_entity_id");
CREATE INDEX IF NOT EXISTS "idx_campfin_cycle" ON "campaign_finance" ("cycle");
CREATE INDEX IF NOT EXISTS "idx_campfin_state" ON "campaign_finance" ("state");
CREATE INDEX IF NOT EXISTS "idx_campfin_office_type" ON "campaign_finance" ("office_type");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_campaign_finance_natural_key"
  ON "campaign_finance" ("fec_candidate_id", "cycle");
