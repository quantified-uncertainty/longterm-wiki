-- Baseline migration: idempotent so it's safe on both fresh and existing databases.
-- The original tables may already exist from the raw-SQL initDb() that preceded Drizzle.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_sequences WHERE sequencename = 'entity_id_seq') THEN
    CREATE SEQUENCE "public"."entity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "citation_content" (
	"url" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"footnote" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"http_status" integer,
	"content_type" text,
	"page_title" text,
	"full_text_preview" text,
	"content_length" integer,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "citation_quotes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"footnote" integer NOT NULL,
	"url" text,
	"resource_id" text,
	"claim_text" text NOT NULL,
	"claim_context" text,
	"source_quote" text,
	"source_location" text,
	"quote_verified" boolean DEFAULT false NOT NULL,
	"verification_method" text,
	"verification_score" real,
	"verified_at" timestamp with time zone,
	"source_title" text,
	"source_type" text,
	"extraction_model" text,
	"accuracy_verdict" text,
	"accuracy_issues" text,
	"accuracy_score" real,
	"accuracy_checked_at" timestamp with time zone,
	"accuracy_supporting_quotes" text,
	"verification_difficulty" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_ids" (
	"numeric_id" integer PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_ids_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cc_page_id" ON "citation_content" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "citation_quotes_page_id_footnote_unique" ON "citation_quotes" USING btree ("page_id","footnote");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cq_page_id" ON "citation_quotes" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cq_url" ON "citation_quotes" USING btree ("url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cq_verified" ON "citation_quotes" USING btree ("quote_verified");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cq_accuracy" ON "citation_quotes" USING btree ("accuracy_verdict");
