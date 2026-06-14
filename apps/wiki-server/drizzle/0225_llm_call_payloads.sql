-- Model-swap eval step 1b: capture LLM request/response bodies.
--
-- One row per sampled API call — the prompt we sent and the completion we got
-- back, plus model + token usage — so we can later replay the same prompts
-- through candidate models and compare quality against the Anthropic baseline.
--
-- Capture is OFF by default and sampled (LLM_PAYLOAD_CAPTURE_RATE in the crux
-- logger); this table only fills when we deliberately turn it on. run_id is a
-- soft reference to pipeline_runs (no FK) so a payload is never lost or blocked
-- on referential integrity. CREATE TABLE completes in ms — normal Drizzle path.
CREATE TABLE IF NOT EXISTS "llm_call_payloads" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text,
	"flow" text,
	"label" text,
	"model" text NOT NULL,
	"via_openrouter" boolean DEFAULT false NOT NULL,
	"request" jsonb NOT NULL,
	"response" text NOT NULL,
	"tokens_input" integer,
	"tokens_output" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_call_payloads_flow" ON "llm_call_payloads" USING btree ("flow");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_call_payloads_model" ON "llm_call_payloads" USING btree ("model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_call_payloads_run_id" ON "llm_call_payloads" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_call_payloads_created_at" ON "llm_call_payloads" USING btree ("created_at");
