-- QUA-942: page-addressable evidence for source-check.
--
-- Adds optional `evidence_locator` JSONB column to `source_check_evidence`,
-- so a single source can carry multiple per-location verdicts (e.g. one row
-- per PDF page, table cell, or HTML anchor) instead of being limited to the
-- whole-source verdict that the row already represents.
--
-- Shape (validated in app code, not by CHECK — JSONB stays flexible for new
-- locator kinds without per-kind migrations):
--
--   { "kind": "pdf-page", "page": 14 }
--   { "kind": "pdf-page", "page": 14, "table": "2.3" }
--   { "kind": "csv-cell", "row": 23, "column": "risk-assessment" }
--   { "kind": "html-anchor", "selector": "#table-2" }
--
-- NULL = whole-source evidence (existing behavior, no migration impact on
-- existing rows). Index is partial so we don't pay storage for the NULL rows
-- that dominate today's evidence corpus.

ALTER TABLE "source_check_evidence"
  ADD COLUMN IF NOT EXISTS "evidence_locator" jsonb;

CREATE INDEX IF NOT EXISTS "idx_sce_evidence_locator"
  ON "source_check_evidence" USING gin ("evidence_locator")
  WHERE "evidence_locator" IS NOT NULL;
