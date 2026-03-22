-- Rename "verification" tables to "source_check" tables.
-- This is a terminology rename: the LLM-based source-checking system was
-- previously called "verification", which conflicted with citation verification
-- and the validation gate. "Source check" better describes what this system does:
-- checking structured data claims against their source URLs.
--
-- ALTER TABLE RENAME is metadata-only (instant, no data movement).
-- Verdict tables (kb_fact_verdicts, record_verdicts, thing_verdicts) keep their
-- names — "verdict" is the correct term for aggregate conclusions.

ALTER TABLE kb_fact_resource_verifications RENAME TO kb_source_checks;
ALTER TABLE record_verifications RENAME TO record_source_checks;
ALTER TABLE thing_resource_verifications RENAME TO thing_source_checks;

-- Rename indexes to match new table names (cosmetic but prevents confusion)
ALTER INDEX idx_kbfrv_fact_id RENAME TO idx_kbsc_fact_id;
ALTER INDEX idx_kbfrv_verdict RENAME TO idx_kbsc_verdict;
ALTER INDEX idx_rv_record RENAME TO idx_rsc_record;
ALTER INDEX idx_rv_verdict RENAME TO idx_rsc_verdict;
ALTER INDEX idx_rv_type RENAME TO idx_rsc_type;
ALTER INDEX idx_trv_thing RENAME TO idx_tsc_thing;
ALTER INDEX idx_trv_verdict RENAME TO idx_tsc_verdict;
