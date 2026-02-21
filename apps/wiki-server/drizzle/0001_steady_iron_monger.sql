CREATE TABLE IF NOT EXISTS "wiki_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"numeric_id" text,
	"title" text NOT NULL,
	"description" text,
	"llm_summary" text,
	"category" text,
	"subcategory" text,
	"entity_type" text,
	"tags" text,
	"quality" integer,
	"reader_importance" integer,
	"hallucination_risk_level" text,
	"hallucination_risk_score" integer,
	"content_plaintext" text,
	"word_count" integer,
	"last_updated" text,
	"content_format" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'wiki_pages' AND column_name = 'search_vector') THEN
    ALTER TABLE "wiki_pages" ADD COLUMN "search_vector" tsvector;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wp_numeric_id" ON "wiki_pages" USING btree ("numeric_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wp_category" ON "wiki_pages" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wp_entity_type" ON "wiki_pages" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wp_reader_importance" ON "wiki_pages" USING btree ("reader_importance");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wp_search_vector" ON "wiki_pages" USING gin ("search_vector");
