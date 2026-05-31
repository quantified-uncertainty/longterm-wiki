-- QUA-1071: sourcing attempt ledger.
--
-- The backfill-sources job re-queries the missing-sources endpoint every night
-- and re-attempts every record still lacking a source URL. Most are a hard
-- residue (URL-less / unverifiable citations) that no-match every time, so the
-- nightly run burns LLM spend re-checking them (~$6/run, ~$180/mo).
--
-- This table records the last attempt per record. The missing-sources queries
-- skip any record attempted within a caller-supplied retry window, so each
-- record is retried at most once per window instead of nightly.
--
-- One row per (table_name, record_id); record_id is text so the numeric-id
-- tables (facts, page_citations) and varchar-id tables (personnel, …) share
-- one ledger. CREATE TABLE completes in milliseconds — normal Drizzle path.
CREATE TABLE IF NOT EXISTS "sourcing_attempts" (
	"table_name" text NOT NULL,
	"record_id" text NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"last_outcome" text,
	CONSTRAINT "sourcing_attempts_table_name_record_id_pk" PRIMARY KEY("table_name","record_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sourcing_attempts_last_attempt_at" ON "sourcing_attempts" USING btree ("last_attempt_at");
