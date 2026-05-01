-- QUA-440: Add linear_id and slot_number to agent_sessions for DB-first dedup.
--
-- Context: QUA-406 added a dedup pre-check to `crux linear start` that reads
-- Linear comments + queries GitHub PR search. That works but is slow and has
-- no heartbeat signal. This migration adds the schema side of the fix.
--
-- See `.claude/rules/github-issue-tracking.md` for the dedup design and
-- QUA-440 for the D- refactor plan (light: new columns only on agent_sessions,
-- leaves active_agents unchanged).
--
-- ADD COLUMN on a nullable text/integer with no default is O(1) in Postgres
-- 11+ (no table rewrite — briefly takes ACCESS EXCLUSIVE, milliseconds).
-- The partial index only scans rows with non-null linear_id, which starts
-- empty — so the index build is immediate.
--
-- Lock profile:
--   ADD COLUMN                 → ACCESS EXCLUSIVE, milliseconds (no rewrite)
--   CREATE INDEX (partial)     → SHARE (blocks writes briefly on an empty subset)
--   ADD CONSTRAINT NOT VALID   → ACCESS EXCLUSIVE, milliseconds (no validation scan)
--   VALIDATE CONSTRAINT        → SHARE UPDATE EXCLUSIVE, milliseconds (no rows to scan)
--
-- Safe on a loaded agent_sessions table; do NOT copy-paste this pattern to
-- a multi-GB table without re-reading docs/agent-rules/database-migrations.md
-- and confirming the NOT VALID + VALIDATE split is actually safe for the
-- lock profile there (cf. QUA-302 / migration 0173's 12-hour deploy stall).

ALTER TABLE "agent_sessions"
  ADD COLUMN IF NOT EXISTS "linear_id" text,
  ADD COLUMN IF NOT EXISTS "slot_number" integer;

-- Partial index: only indexes rows that have been written with a Linear ID.
-- Used by the dedup pre-check to answer "which active sessions claim QUA-NNN?"
-- in a single index seek.
CREATE INDEX IF NOT EXISTS "idx_as_linear_id"
  ON "agent_sessions" ("linear_id")
  WHERE "linear_id" IS NOT NULL;

-- CHECK constraint: linear_id must match the canonical Linear identifier
-- format. Enforced at the DB level so a bad write gets caught before it
-- poisons the dedup query. `NOT VALID` skips the retroactive scan; no
-- existing rows have linear_id so there is nothing to validate.
ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "chk_agent_sessions_linear_id_format"
  CHECK ("linear_id" IS NULL OR "linear_id" ~ '^[A-Z]+-[0-9]+$')
  NOT VALID;

ALTER TABLE "agent_sessions" VALIDATE CONSTRAINT "chk_agent_sessions_linear_id_format";

-- CHECK constraint: slot_number is bounded to 0-99 (we have 20 slots today,
-- allow headroom). Rejects negative or absurd values early.
ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "chk_agent_sessions_slot_number_range"
  CHECK ("slot_number" IS NULL OR ("slot_number" >= 0 AND "slot_number" <= 99))
  NOT VALID;

ALTER TABLE "agent_sessions" VALIDATE CONSTRAINT "chk_agent_sessions_slot_number_range";
