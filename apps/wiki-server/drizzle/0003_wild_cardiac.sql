CREATE TABLE "citation_accuracy_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"total_citations" integer NOT NULL,
	"checked_citations" integer NOT NULL,
	"accurate_count" integer DEFAULT 0 NOT NULL,
	"minor_issues_count" integer DEFAULT 0 NOT NULL,
	"inaccurate_count" integer DEFAULT 0 NOT NULL,
	"unsupported_count" integer DEFAULT 0 NOT NULL,
	"not_verifiable_count" integer DEFAULT 0 NOT NULL,
	"average_score" real,
	"snapshot_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_cas_page_id" ON "citation_accuracy_snapshots" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "idx_cas_snapshot_at" ON "citation_accuracy_snapshots" USING btree ("snapshot_at");