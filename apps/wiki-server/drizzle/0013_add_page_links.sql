CREATE TABLE IF NOT EXISTS "page_links" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"target_id" text NOT NULL,
	"link_type" text NOT NULL,
	"relationship" text,
	"weight" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_pl_source_target_type" ON "page_links" USING btree ("source_id","target_id","link_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pl_source_id" ON "page_links" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pl_target_id" ON "page_links" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pl_link_type" ON "page_links" USING btree ("link_type");
