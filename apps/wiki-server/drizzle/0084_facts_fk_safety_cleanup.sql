-- Safety cleanup for facts FK migration (0083).
--
-- Migration 0083 assumes entities.stable_id is fully populated. On fresh
-- deployments where the backfill hasn't run, some facts may still have slug
-- entity_ids or dangling subject references after 0083's conversion steps.
-- This migration deletes/nulls those leftovers so the FK constraints hold.
--
-- On production this is a no-op (data was manually fixed during the 2026-03-13
-- outage before 0083 was applied).

-- Delete facts whose entity_id is still a slug (not in entities.stable_id).
DELETE FROM facts
WHERE entity_id NOT IN (SELECT stable_id FROM entities WHERE stable_id IS NOT NULL);

-- Null out subject values that are still slugs.
UPDATE facts SET subject = NULL
WHERE subject IS NOT NULL
  AND subject NOT IN (SELECT stable_id FROM entities WHERE stable_id IS NOT NULL);
