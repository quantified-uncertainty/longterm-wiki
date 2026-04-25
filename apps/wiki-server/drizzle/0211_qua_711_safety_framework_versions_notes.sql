-- QUA-711 Phase 4-D: add `notes` column to `safety_framework_versions`.
--
-- The Phase 4 fetch helper (`crux/frameworks/fetch.ts::fetchFramework`)
-- already returns a `note` field that explains Wayback fallback state
-- ("Wayback push failed or returned no snapshot", "Wayback push skipped").
-- Without a column to persist it, the rationale was lost between fetch
-- and ingest.
--
-- The Phase 4-D `validate-framework-versions.ts` validator enforces that
-- every published version has either `wayback_snapshot_url` set OR an
-- explicit `notes` value flagging Wayback skipped. This column is the
-- carrier for the latter.

ALTER TABLE "safety_framework_versions"
  ADD COLUMN IF NOT EXISTS "notes" text;
