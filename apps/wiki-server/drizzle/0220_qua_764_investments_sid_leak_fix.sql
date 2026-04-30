-- QUA-764: Fix `investments` rows with sid_ leaks (NULL company_entity_id /
-- investor_entity_id and a sid_-prefixed value in the raw text column).
--
-- 7 rows had `company_id LIKE 'sid_%'` with `company_entity_id IS NULL`. The
-- entity-FK left-join therefore resolved to NULL and the raw `sid_*` value
-- leaked into UI/reports/backfill claims. The audit step (see PR description)
-- found 5 additional rows with the same shape on `investor_id` (3 rows
-- distinct from the 7 above; 2 rows had both leaks).
--
-- Two flavors per the ticket:
--   - Title-with-prefix (2 rows): `sid_Storyworth` and `sid_Playground`.
--     Real entities exist (`storyworth` / sid_kT85f91plA, `playground-ai` /
--     sid_kh5x0eezrQ). Normalize: set the FK + slug, keep the row.
--   - Orphan sids (8 rows total: 5 company-side + 3 investor-side, with 2
--     rows having both): no matching entity in `entities`. Delete the row;
--     `company_id`/`investor_id` are NOT NULL so the ticket's "null both
--     columns" option isn't available.
--
-- F3 trade-off — single-side investor leaks: the 3 "investor-only" leak
-- rows (6GS_vh6msp Algolia/Seed/2014, G7xvfoDpI3 Rippling/Series A/$45M,
-- Wq9J6mOQFe Rippling/Series C/2021) have valid resolved companies. The
-- DELETE WHERE clause uses `OR` between company-leak and investor-leak
-- predicates, so these 3 rows are deleted along with their orphan-company
-- counterparts. We accept the loss (small, partial-data rows) for
-- consistent treatment — preserving the row would require either keeping
-- the raw sid in investor_id (still leaks) or substituting a placeholder
-- that doesn't resolve (would make future re-syncs fail entityRefs
-- validation). The ticket's acceptance language ("delete or null both")
-- is consistent with delete here.
--
-- Idempotent: every step is gated on the bug pattern (sid_ in the raw
-- column AND no resolved FK). Safe to re-run on a fresh DB or after partial
-- application; second run is a no-op.
--
-- Pattern-based, not hardcoded by row id (see
-- .claude/rules/database-migrations.md "Adding unique constraints" —
-- analogous reasoning: hardcoded ids miss any new rows that match the
-- same shape, e.g. if the bad sync re-ran).
--
-- Other tables audited per ticket scope (prod 2026-04-29, fix-if-found):
--   - investments.investor_id ........ 5 leaks → covered above
--   - equity_positions.{company_id, holder_id} ... 0
--   - funding_rounds.company_id ...... 0
--   - personnel.{organization_id, person_id} ..... 0
--   - divisions.parent_org_id ........ N/A — different schema (parent_org_id
--     IS the FK column with `REFERENCES entities(stable_id)`, so the
--     orphan-sid pattern is structurally impossible there)
--
-- Systemic protection: the `investments POST /sync` route already calls
-- `validateEntityRefs()` (sync-factory `entityRefFields` config), which
-- rejects any companyId/investorId not matching an entity. These 10 rows
-- predate that protection. No code change required.
--
-- things_search materialized view: this migration deletes 8 things rows
-- and rewrites parent_thing_id on 2 more. We do NOT issue an explicit
-- `REFRESH MATERIALIZED VIEW` here — the things_search MV is 78MB / 40k
-- rows (per migration 0190) and a non-CONCURRENT refresh inside the
-- migration transaction would hold AccessExclusiveLock for ~30-60s,
-- blocking user-facing search. The hourly groundskeeper REFRESH
-- (CONCURRENTLY) picks the changes up within ~1h. Acceptable staleness
-- for a 10-row data fix; the deleted sids never appeared in user-friendly
-- search anyway (they were displayed as raw `sid_*`).

-- Phase 0: pre-flight — verify target entities exist before normalizing.
-- The UPDATE in Phase 1 would otherwise fail loudly on a FK violation, but
-- raising an explicit exception here gives operators a clearer error
-- (and keeps the migration loudly fail-closed rather than silently
-- skipping rows if someone, e.g., dropped these entities from YAML).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "entities" WHERE "stable_id" = 'sid_kT85f91plA') THEN
    RAISE EXCEPTION 'QUA-764 aborted: entity sid_kT85f91plA (storyworth) not found in entities. Cannot link sid_Storyworth investments rows.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "entities" WHERE "stable_id" = 'sid_kh5x0eezrQ') THEN
    RAISE EXCEPTION 'QUA-764 aborted: entity sid_kh5x0eezrQ (playground-ai) not found in entities. Cannot link sid_Playground investments rows.';
  END IF;
END $$;

DO $$
DECLARE
  storyworth_updated INT;
  playground_updated INT;
  things_deleted INT;
  rows_deleted INT;
BEGIN
  -- Phase 1a: Normalize sid_Storyworth → entity 'storyworth' (sid_kT85f91plA)
  UPDATE "investments"
  SET
    "company_entity_id" = 'sid_kT85f91plA',
    "company_id"        = 'storyworth',
    "company_display_name" = COALESCE("company_display_name", 'StoryWorth'),
    "updated_at"        = NOW()
  WHERE "company_id" = 'sid_Storyworth'
    AND "company_entity_id" IS NULL;
  GET DIAGNOSTICS storyworth_updated = ROW_COUNT;
  RAISE NOTICE 'QUA-764: normalized sid_Storyworth → storyworth on % row(s)', storyworth_updated;

  -- Phase 1b: Normalize sid_Playground → entity 'playground-ai' (sid_kh5x0eezrQ)
  UPDATE "investments"
  SET
    "company_entity_id" = 'sid_kh5x0eezrQ',
    "company_id"        = 'playground-ai',
    "company_display_name" = COALESCE("company_display_name", 'Playground'),
    "updated_at"        = NOW()
  WHERE "company_id" = 'sid_Playground'
    AND "company_entity_id" IS NULL;
  GET DIAGNOSTICS playground_updated = ROW_COUNT;
  RAISE NOTICE 'QUA-764: normalized sid_Playground → playground-ai on % row(s)', playground_updated;

  -- Phase 1c: keep `things.parent_thing_id` in sync with the normalized
  -- company_id. The route's `toThing` writes parent_thing_id = companyId at
  -- sync time, so the existing things rows for these 2 investments still
  -- hold 'sid_Storyworth' / 'sid_Playground'. The hourly things_search MV
  -- refresh (groundskeeper) propagates parent_thing_id into the search
  -- index — leaving them stale would let the bad sids resurface in search
  -- until the next re-sync. Idempotent via the predicate match.
  UPDATE "things"
  SET "parent_thing_id" = 'storyworth',
      "updated_at"      = NOW()
  WHERE "source_table" = 'investments'
    AND "parent_thing_id" = 'sid_Storyworth';

  UPDATE "things"
  SET "parent_thing_id" = 'playground-ai',
      "updated_at"      = NOW()
  WHERE "source_table" = 'investments'
    AND "parent_thing_id" = 'sid_Playground';

  -- Phase 2: Delete `things` rows for orphan investments first (FK-safe ordering).
  -- Match criteria: investments rows where either `company_id` or `investor_id`
  -- is sid_-prefixed, the corresponding entity FK is NULL, and the sid does
  -- not resolve against the current entities table.
  DELETE FROM "things"
  WHERE "source_table" = 'investments'
    AND "source_id" IN (
      SELECT i."id" FROM "investments" i
      WHERE
        (
          i."company_id" LIKE 'sid_%'
          AND i."company_entity_id" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "entities" e WHERE e."stable_id" = i."company_id"
          )
        )
        OR
        (
          i."investor_id" LIKE 'sid_%'
          AND i."investor_entity_id" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "entities" e WHERE e."stable_id" = i."investor_id"
          )
        )
    );
  GET DIAGNOSTICS things_deleted = ROW_COUNT;
  RAISE NOTICE 'QUA-764: deleted % orphan things row(s) for investments', things_deleted;

  -- Phase 3: Delete the orphan investments rows themselves.
  -- Same predicate as Phase 2.
  DELETE FROM "investments" i
  WHERE
    (
      i."company_id" LIKE 'sid_%'
      AND i."company_entity_id" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "entities" e WHERE e."stable_id" = i."company_id"
      )
    )
    OR
    (
      i."investor_id" LIKE 'sid_%'
      AND i."investor_entity_id" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "entities" e WHERE e."stable_id" = i."investor_id"
      )
    );
  GET DIAGNOSTICS rows_deleted = ROW_COUNT;
  RAISE NOTICE 'QUA-764: deleted % orphan investments row(s)', rows_deleted;
END $$;
