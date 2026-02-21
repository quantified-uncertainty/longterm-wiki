CREATE TABLE IF NOT EXISTS "edit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"date" date NOT NULL,
	"tool" text NOT NULL,
	"agency" text NOT NULL,
	"requested_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_el_page_id" ON "edit_logs" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_el_date" ON "edit_logs" USING btree ("date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_el_tool" ON "edit_logs" USING btree ("tool");
