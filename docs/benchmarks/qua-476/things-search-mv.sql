-- docs/benchmarks/qua-476/things-search-mv.sql
-- Candidate materialized view definition for Phase 4b-B.2b.
-- STATUS: candidate only — benchmarked in Phase 4b-B.2a (QUA-476), NOT yet applied to prod.
-- Parent epic: QUA-408. Audit: docs/audits/things-denormalization-audit.md.
--
-- Purpose: move `things.title` / `things.description` / `things.parent_title` from
-- write-time denormalization (22 sync handlers, per QUA-414 audit) to read-time
-- resolution via a materialized view. The generated `things.search_vector` column
-- is replaced by a tsvector column in the MV, refreshed CONCURRENTLY so readers
-- are never blocked.
--
-- Scope note: this file is the SHAPE we want to prove is viable. Phase 4b-B.2b
-- will migrate the composer dispatch table (QUA-470) from write-time callers to
-- the MV refresh query so titles are resolved exactly once — at refresh time —
-- from the source tables. For the 2a benchmark, we build the MV directly on the
-- existing `things` table so we can measure refresh time, GIN build time, and
-- query latency without having to migrate every composer first.
--
-- IMPORTANT: CONCURRENT refresh requires a UNIQUE index on the MV.

--
-- === 2a benchmark shape (self-SELECT from things) ===
--
-- Used for the Phase 2a benchmark. Source rows come from `things` itself. This
-- lets us measure MV runtime characteristics (refresh time, GIN build, query
-- latency) with zero JOIN cost, which sets a lower-bound refresh-time estimate.
-- The real 2b MV will add JOINs to source tables; we separately measure the
-- JOIN cost and add it to the 2a refresh number.

CREATE MATERIALIZED VIEW IF NOT EXISTS things_search AS
SELECT
  t.id,
  t.thing_type,
  t.title,
  t.parent_thing_id,
  t.source_table,
  t.source_id,
  t.entity_type,
  t.description,
  t.source_url,
  t.wiki_id,
  t.parent_title,
  t.created_at,
  t.updated_at,
  t.synced_at,
  (
    setweight(to_tsvector('english', coalesce(t.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(t.parent_title, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(t.description, '')), 'C') ||
    setweight(to_tsvector('english',
      coalesce(replace(t.thing_type, '-', ' '), '') || ' ' ||
      coalesce(replace(t.entity_type, '-', ' '), '')
    ), 'D')
  ) AS search_vector
FROM things t
WITH NO DATA;

-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS things_search_pkey
  ON things_search (id);

-- Full-text search index (matches idx_things_search on the current table).
CREATE INDEX IF NOT EXISTS things_search_gin
  ON things_search USING GIN (search_vector);

-- Secondary indexes mirrored from the current `things` table. Kept identical so
-- /api/things/{search,list,children} can switch over with no query rewrites.
CREATE INDEX IF NOT EXISTS things_search_type_idx
  ON things_search (thing_type);
CREATE INDEX IF NOT EXISTS things_search_parent_idx
  ON things_search (parent_thing_id);
CREATE INDEX IF NOT EXISTS things_search_entity_type_idx
  ON things_search (entity_type);
CREATE INDEX IF NOT EXISTS things_search_updated_idx
  ON things_search (updated_at);

-- For the ILIKE / trigram fallbacks in /api/things/search phase 2+3.
-- These are optional; enable only if the fallbacks remain on the MV in 2b.
-- CREATE INDEX things_search_title_trgm ON things_search USING GIN (title gin_trgm_ops);

-- To refresh (after initial population):
--   REFRESH MATERIALIZED VIEW CONCURRENTLY things_search;

--
-- === 2b target shape (compose from source tables) — SKETCH, NOT BENCHMARKED ===
--
-- In 2b, the MV's underlying query becomes a UNION ALL across every source
-- table, composing title / description / parent_title via the same logic
-- currently in apps/wiki-server/src/routes/shared/compose-thing.ts. Example
-- fragment for entities:
--
--   SELECT
--     e.stable_id                  AS id,
--     'entity'                     AS thing_type,
--     e.title                      AS title,
--     NULL::text                   AS parent_thing_id,
--     'entities'                   AS source_table,
--     e.id                         AS source_id,
--     e.entity_type                AS entity_type,
--     e.description                AS description,
--     e.website                    AS source_url,
--     e.wiki_id                    AS wiki_id,
--     NULL::text                   AS parent_title,
--     e.created_at, e.updated_at, NOW() AS synced_at,
--     (search_vector expression)   AS search_vector
--   FROM entities e
--   UNION ALL ...
--
-- This is sketched here so the reader can see the intended 2b target; the
-- benchmark does NOT execute it. Refresh time for the UNION ALL variant will
-- be measured as part of Phase 4b-B.2b when composer dispatch is migrated.
