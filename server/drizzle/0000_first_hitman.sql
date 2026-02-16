CREATE SEQUENCE "public"."entity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "edit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"date" date NOT NULL,
	"tool" text NOT NULL,
	"agency" text NOT NULL,
	"requested_by" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_ids" (
	"id" serial PRIMARY KEY NOT NULL,
	"numeric_id" integer NOT NULL,
	"slug" text NOT NULL,
	"entity_type" text,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_ids_numeric_id_unique" UNIQUE("numeric_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "entity_ids_slug_idx" ON "entity_ids" USING btree ("slug");