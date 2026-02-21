CREATE TABLE IF NOT EXISTS "summaries" (
	"entity_id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"one_liner" text,
	"summary" text,
	"review" text,
	"key_points" jsonb,
	"key_claims" jsonb,
	"model" text,
	"tokens_used" integer,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sum_entity_type" ON "summaries" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sum_model" ON "summaries" USING btree ("model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sum_generated_at" ON "summaries" USING btree ("generated_at");
