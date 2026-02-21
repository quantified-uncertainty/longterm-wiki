CREATE TABLE IF NOT EXISTS "claims" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"claim_type" text NOT NULL,
	"claim_text" text NOT NULL,
	"value" text,
	"unit" text,
	"confidence" text,
	"source_quote" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cl_entity_id" ON "claims" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cl_entity_type" ON "claims" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cl_claim_type" ON "claims" USING btree ("claim_type");
