CREATE TABLE IF NOT EXISTS "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"numeric_id" text,
	"entity_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"website" text,
	"tags" jsonb,
	"clusters" jsonb,
	"status" text,
	"last_updated" text,
	"custom_fields" jsonb,
	"related_entries" jsonb,
	"sources" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ent_numeric_id" ON "entities" USING btree ("numeric_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ent_entity_type" ON "entities" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ent_title" ON "entities" USING btree ("title");
