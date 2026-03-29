-- Job queue enhancements for K8s worker deployment:
-- Add run_after (delayed execution), dedup_key (idempotent enqueue),
-- parent_job_id (job hierarchy), and cost_usd (cost tracking).

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS run_after timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dedup_key text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS parent_job_id bigint REFERENCES jobs(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cost_usd numeric(10,4);

CREATE INDEX IF NOT EXISTS idx_jobs_run_after ON jobs (run_after) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedup_active ON jobs (dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('pending', 'claimed', 'running');
CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs (parent_job_id) WHERE parent_job_id IS NOT NULL;
