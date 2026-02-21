CREATE TABLE "session_pages" (
	"session_id" bigserial NOT NULL,
	"page_id" text NOT NULL,
	CONSTRAINT "session_pages_session_id_page_id_pk" PRIMARY KEY("session_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"branch" text,
	"title" text NOT NULL,
	"summary" text,
	"model" text,
	"duration" text,
	"cost" text,
	"pr_url" text,
	"checks_yaml" text,
	"issues_json" jsonb,
	"learnings_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_pages" ADD CONSTRAINT "session_pages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_sp_page_id" ON "session_pages" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "idx_sess_date" ON "sessions" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_sess_branch" ON "sessions" USING btree ("branch");