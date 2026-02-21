CREATE TABLE IF NOT EXISTS "hallucination_risk_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"score" integer NOT NULL,
	"level" text NOT NULL,
	"factors" jsonb,
	"integrity_issues" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hrs_page_id" ON "hallucination_risk_snapshots" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hrs_computed_at" ON "hallucination_risk_snapshots" USING btree ("computed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hrs_level" ON "hallucination_risk_snapshots" USING btree ("level");
