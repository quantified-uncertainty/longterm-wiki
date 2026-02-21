-- Defensive: create tables IF NOT EXISTS in case migration 0007 was recorded
-- but the tables don't actually exist (same pattern as 0008 fix).
CREATE TABLE IF NOT EXISTS "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"type" text,
	"summary" text,
	"review" text,
	"abstract" text,
	"key_points" jsonb,
	"publication_id" text,
	"authors" jsonb,
	"published_date" date,
	"tags" jsonb,
	"local_filename" text,
	"credibility_override" real,
	"fetched_at" timestamp with time zone,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resource_citations" (
	"resource_id" text NOT NULL,
	"page_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_citations_resource_id_page_id_pk" PRIMARY KEY("resource_id","page_id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_res_url" ON "resources" USING btree ("url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_res_type" ON "resources" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_res_publication_id" ON "resources" USING btree ("publication_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_rc_page_id" ON "resource_citations" USING btree ("page_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'resource_citations_resource_id_resources_id_fk'
      AND table_name = 'resource_citations'
  ) THEN
    ALTER TABLE "resource_citations" ADD CONSTRAINT "resource_citations_resource_id_resources_id_fk"
    FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
