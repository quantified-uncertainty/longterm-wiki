CREATE TABLE "resource_citations" (
	"resource_id" text NOT NULL,
	"page_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_citations_resource_id_page_id_pk" PRIMARY KEY("resource_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "resources" (
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
);
--> statement-breakpoint
CREATE INDEX "idx_rc_page_id" ON "resource_citations" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_res_url" ON "resources" USING btree ("url");--> statement-breakpoint
CREATE INDEX "idx_res_type" ON "resources" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_res_publication_id" ON "resources" USING btree ("publication_id");