-- Rename improve_run_artifacts → page_improve_runs for clarity.
-- Also renames indexes from idx_ira_* → idx_pir_*.

ALTER TABLE improve_run_artifacts RENAME TO page_improve_runs;

ALTER INDEX idx_ira_page_id RENAME TO idx_pir_page_id;
ALTER INDEX idx_ira_engine RENAME TO idx_pir_engine;
ALTER INDEX idx_ira_started_at RENAME TO idx_pir_started_at;
ALTER INDEX idx_ira_page_started RENAME TO idx_pir_page_started;
