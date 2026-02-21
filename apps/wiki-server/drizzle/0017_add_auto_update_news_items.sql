CREATE TABLE IF NOT EXISTS "auto_update_news_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL REFERENCES "auto_update_runs"("id") ON DELETE CASCADE,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"source_id" text NOT NULL,
	"published_at" text,
	"summary" text,
	"relevance_score" integer,
	"topics_json" jsonb,
	"entities_json" jsonb,
	"routed_to_page_id" text,
	"routed_to_page_title" text,
	"routed_tier" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auni_run_id" ON "auto_update_news_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auni_source_id" ON "auto_update_news_items" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auni_relevance" ON "auto_update_news_items" USING btree ("relevance_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auni_routed_page" ON "auto_update_news_items" USING btree ("routed_to_page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_auni_published_at" ON "auto_update_news_items" USING btree ("published_at");
