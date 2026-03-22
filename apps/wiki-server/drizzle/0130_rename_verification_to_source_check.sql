-- Rename verification tables to source-check (metadata-only, instant).
-- The LLM-based source-checking system was named "verification" but this
-- overlaps with citation verification and the validation gate.
-- "source-check" accurately describes what the system does: checking data
-- claims against source URLs.

ALTER TABLE verification_evidence RENAME TO source_check_evidence;
ALTER TABLE verification_verdicts RENAME TO source_check_verdicts;

-- Rename indexes
ALTER INDEX idx_ve_record RENAME TO idx_sce_record;
ALTER INDEX idx_ve_entity RENAME TO idx_sce_entity;
ALTER INDEX idx_ve_verdict RENAME TO idx_sce_verdict;
ALTER INDEX idx_ve_checked RENAME TO idx_sce_checked;
ALTER INDEX idx_vv_verdict RENAME TO idx_scv_verdict;
ALTER INDEX idx_vv_recheck RENAME TO idx_scv_recheck;
ALTER INDEX idx_vv_entity RENAME TO idx_scv_entity;
ALTER INDEX idx_vv_type RENAME TO idx_scv_type;
