-- Repair schema drift observed in production: the migration ledger has
-- advanced beyond 0211, but safety_framework_versions.notes is still absent.
-- A forward, additive migration repairs that deployment and preserves notes
-- in databases where the original migration was already applied.
ALTER TABLE "safety_framework_versions"
  ADD COLUMN IF NOT EXISTS "notes" text;
