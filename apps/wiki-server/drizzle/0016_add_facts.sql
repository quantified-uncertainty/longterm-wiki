CREATE TABLE IF NOT EXISTS "facts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"fact_id" text NOT NULL,
	"label" text,
	"value" text,
	"numeric" real,
	"low" real,
	"high" real,
	"as_of" text,
	"measure" text,
	"subject" text,
	"note" text,
	"source" text,
	"source_resource" text,
	"format" text,
	"format_divisor" real,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_facts_entity_fact" ON "facts" USING btree ("entity_id","fact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_facts_entity_id" ON "facts" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_facts_measure" ON "facts" USING btree ("measure");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_facts_as_of" ON "facts" USING btree ("as_of");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_facts_subject" ON "facts" USING btree ("subject");
