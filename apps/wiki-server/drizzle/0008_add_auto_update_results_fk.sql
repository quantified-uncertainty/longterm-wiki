-- Defensive: create tables IF NOT EXISTS in case migration 0006 was recorded
-- but the tables don't actually exist (e.g. DB state inconsistency after deploy).
CREATE TABLE IF NOT EXISTS "auto_update_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"trigger" text NOT NULL,
	"budget_limit" real,
	"budget_spent" real,
	"sources_checked" integer,
	"sources_failed" integer,
	"items_fetched" integer,
	"items_relevant" integer,
	"pages_planned" integer,
	"pages_updated" integer,
	"pages_failed" integer,
	"pages_skipped" integer,
	"new_pages_created" text,
	"details_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auto_update_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"page_id" text NOT NULL,
	"status" text NOT NULL,
	"tier" text,
	"duration_ms" integer,
	"error_message" text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aures_run_id" ON "auto_update_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aures_page_id" ON "auto_update_results" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aures_status" ON "auto_update_results" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aur_date" ON "auto_update_runs" USING btree ("date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aur_trigger" ON "auto_update_runs" USING btree ("trigger");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_aur_started_at" ON "auto_update_runs" USING btree ("started_at");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'auto_update_results_run_id_auto_update_runs_id_fk'
      AND table_name = 'auto_update_results'
  ) THEN
    ALTER TABLE "auto_update_results" ADD CONSTRAINT "auto_update_results_run_id_auto_update_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."auto_update_runs"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
