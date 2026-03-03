import { Hono } from "hono";
import { z } from "zod";
import { getDb, getDrizzleDb, type SqlQuery } from "../db.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "./utils.js";
import { SyncLinksBatchSchema } from "../api-types.js";
import { resolvePageIntId } from "./page-id-helpers.js";

// ---- Constants ----

const MAX_RELATED = 25;
const MIN_SCORE = 1.0;
const MIN_PER_TYPE = 2;

/**
 * Inverse relationship labels — given a forward label, returns the reverse.
 * e.g. "causes" → "caused by"
 */
const INVERSE_LABEL: Record<string, string> = {
  causes: "caused by",
  cause: "caused by",
  mitigates: "mitigated by",
  "mitigated-by": "mitigates",
  mitigation: "mitigated by",
  requires: "required by",
  enables: "enabled by",
  blocks: "blocked by",
  supersedes: "superseded by",
  increases: "increased by",
  decreases: "decreased by",
  supports: "supported by",
  measures: "measured by",
  "measured-by": "measures",
  "analyzed-by": "analyzes",
  analyzes: "analyzed by",
  "child-of": "parent of",
  "composed-of": "component of",
  component: "composed of",
  addresses: "addressed by",
  affects: "affected by",
  amplifies: "amplified by",
  "contributes-to": "receives contribution from",
  "driven-by": "drives",
  driver: "driven by",
  drives: "driven by",
  "leads-to": "leads",
  "shaped-by": "shapes",
  prerequisite: "depends on",
  research: "researched by",
  models: "modeled by",
};

// ---- Schemas (from shared api-types) ----

const SyncBatchSchema = SyncLinksBatchSchema;

const BacklinksQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const RelatedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(MAX_RELATED),
});

// ---- Raw SQL row types ----

interface BacklinkDbRow {
  source_id: string;
  relationship: string | null;
  link_type: string;
  weight: number;
  source_title: string | null;
  source_type: string | null;
}

interface RelatedDbRow {
  id: string;
  raw_score: number;
  relationship: string | null;
  relationship_is_reverse: boolean | null;
  title: string | null;
  entity_type: string | null;
  quality: number | null;
  reader_importance: number | null;
  score: string;
}

interface GraphEdgeDbRow {
  source_id: string;
  target_id: string;
  link_type: string;
  relationship: string | null;
  weight: number;
  source_type: string | null;
  source_title: string | null;
  target_type: string | null;
  target_title: string | null;
}

interface LinkStatsRow {
  link_type: string;
  count: number;
  avg_weight: string;
}

interface TotalRow {
  total: number;
}

interface UniqueCountRow {
  sources: number;
  targets: number;
}

// ---- POST /sync ----

// Advisory lock key for serializing page_links sync operations.
// Prevents deadlocks when multiple callers (CI, local builds) sync concurrently.
const PAGE_LINKS_SYNC_LOCK = 7_294_801;

const linksApp = new Hono()
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { links, replace } = parsed.data;
    const rawDb = getDb();

    let upserted = 0;

    // Use a raw postgres transaction with an advisory lock to serialize concurrent
    // sync operations. Without this, two concurrent syncs deadlock on the unique
    // index when inserting overlapping rows.
    await rawDb.begin(async (txRaw) => {
      const tx = txRaw as unknown as SqlQuery;
      await tx`SELECT pg_advisory_xact_lock(${PAGE_LINKS_SYNC_LOCK})`;

      if (replace) {
        await tx`DELETE FROM page_links`;
      }

      // Batch upsert — on conflict (source, target, type) update weight + relationship
      // Phase D2a: write only integer columns (source_id_old / target_id_old dropped)
      for (let i = 0; i < links.length; i += 500) {
        const batch = links.slice(i, i + 500);

        // Use RETURNING to count actual rows written — INNER JOINs drop unresolved slugs,
        // so batch.length would over-count and mask data loss (especially with replace=true).
        const affected = await tx<{ one: number }[]>`
        INSERT INTO page_links (link_type, relationship, weight, source_id_int, target_id_int)
        SELECT t."linkType", t.relationship, t.weight,
               ei_src.numeric_id, ei_tgt.numeric_id
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
        AS t("sourceId" text, "targetId" text, "linkType" text, relationship text, weight real)
        JOIN entity_ids ei_src ON ei_src.slug = t."sourceId"
        JOIN entity_ids ei_tgt ON ei_tgt.slug = t."targetId"
        -- INNER JOIN: skip rows with unresolved slugs (prevents NULL-ID orphans bypassing conflict)
        -- Requires page_links_source_target_int_unique index (created in phase-d2a-predeploy.sql)
        ON CONFLICT (source_id_int, target_id_int, link_type)
        DO UPDATE SET weight = EXCLUDED.weight, relationship = EXCLUDED.relationship
        RETURNING 1 AS one
      `;

        upserted += affected.length;
      }
    });

    return c.json({ upserted });
  })

  // ---- GET /backlinks/:id ----

  .get("/backlinks/:id", async (c) => {
    const targetId = c.req.param("id");
    if (!targetId) return validationError(c, "Entity ID is required");

    const parsed = BacklinksQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { limit } = parsed.data;
    const rawDb = getDb();

    // Phase 4b: resolve slug to integer and query by target_id_int
    const db = getDrizzleDb();
    const targetIntId = await resolvePageIntId(db, targetId);
    if (targetIntId === null) {
      return c.json({ targetId, backlinks: [], total: 0 });
    }

    // Find all pages/entities that link TO this target.
    // Join with wiki_pages to get title and entity_type for the source.
    // Deduplicate by source_id (a source may link via multiple link_types),
    // then order by weight descending (most relevant first).
    const results = await rawDb<BacklinkDbRow[]>`
    SELECT * FROM (
      SELECT DISTINCT ON (pl.source_id_int)
        wp.id AS source_id,
        pl.link_type,
        pl.relationship,
        pl.weight,
        wp.title AS source_title,
        wp.entity_type AS source_type
      FROM page_links pl
      LEFT JOIN wiki_pages wp ON wp.integer_id = pl.source_id_int
      -- Filter NULL source_id_int: DISTINCT ON NULLs would collapse into one group with a NULL id
      WHERE pl.target_id_int = ${targetIntId} AND pl.source_id_int IS NOT NULL
      ORDER BY pl.source_id_int, pl.weight DESC
    ) sub
    ORDER BY sub.weight DESC
    LIMIT ${limit}
  `;

    const backlinks = results.map((r) => ({
      id: r.source_id,
      type: r.source_type || "concept",
      title: r.source_title || r.source_id,
      relationship: r.relationship || undefined,
      linkType: r.link_type,
      weight: r.weight,
    }));

    return c.json({
      targetId,
      backlinks,
      total: backlinks.length,
    });
  })

  // ---- GET /related/:id ----

  .get("/related/:id", async (c) => {
    const entityId = c.req.param("id");
    if (!entityId) return validationError(c, "Entity ID is required");

    const parsed = RelatedQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { limit } = parsed.data;
    const rawDb = getDb();

    // Phase 4b: resolve slug to integer and query by source_id_int / target_id_int
    const db = getDrizzleDb();
    const entityIntId = await resolvePageIntId(db, entityId);
    if (entityIntId === null) {
      return c.json({ entityId, related: [], total: 0 });
    }

    // Compute related pages by aggregating all link signals bidirectionally.
    // For each neighbor, sum the weights of all link types connecting them.
    // Apply quality boost: 1 + quality/40 + reader_importance/400 (max ~1.45x).
    // Relationship labels come from yaml_related links.
    const results = await rawDb<RelatedDbRow[]>`
    WITH bidirectional_links AS (
      -- Forward links: entityId is source (is_reverse = false)
      SELECT target_id_int AS neighbor_int_id, link_type, relationship, weight, false AS is_reverse
      FROM page_links
      WHERE source_id_int = ${entityIntId}
      UNION ALL
      -- Reverse links: entityId is target (is_reverse = true)
      SELECT source_id_int AS neighbor_int_id, link_type, relationship, weight, true AS is_reverse
      FROM page_links
      WHERE target_id_int = ${entityIntId}
    ),
    aggregated AS (
      SELECT
        bl.neighbor_int_id,
        SUM(bl.weight) AS raw_score,
        -- Pick the first non-null relationship label (from yaml_related)
        (SELECT bl2.relationship
         FROM bidirectional_links bl2
         WHERE bl2.neighbor_int_id = bl.neighbor_int_id
           AND bl2.relationship IS NOT NULL
           AND bl2.link_type = 'yaml_related'
         LIMIT 1
        ) AS relationship,
        -- Track direction of the yaml_related link for label inversion
        (SELECT bl2.is_reverse
         FROM bidirectional_links bl2
         WHERE bl2.neighbor_int_id = bl.neighbor_int_id
           AND bl2.relationship IS NOT NULL
           AND bl2.link_type = 'yaml_related'
         LIMIT 1
        ) AS relationship_is_reverse
      FROM bidirectional_links bl
      WHERE bl.neighbor_int_id != ${entityIntId}
      GROUP BY bl.neighbor_int_id
    )
    SELECT
      wp.id AS id,
      a.raw_score,
      a.relationship,
      a.relationship_is_reverse,
      wp.title,
      wp.entity_type,
      wp.quality,
      wp.reader_importance,
      -- Apply quality boost: unrated pages get defaults (q=5, imp=50)
      a.raw_score * (1.0 + COALESCE(wp.quality, 5)::real / 40.0
                         + COALESCE(wp.reader_importance, 50)::real / 400.0) AS score
    FROM aggregated a
    LEFT JOIN wiki_pages wp ON wp.integer_id = a.neighbor_int_id
    WHERE a.raw_score * (1.0 + COALESCE(wp.quality, 5)::real / 40.0
                             + COALESCE(wp.reader_importance, 50)::real / 400.0) >= ${MIN_SCORE}
    ORDER BY score DESC
    LIMIT ${limit * 3}
  `;

    // Type-diverse selection: guarantee MIN_PER_TYPE from each entity type,
    // then fill remaining slots with highest-scoring entries.
    const scored = results.map((r) => ({
      id: r.id,
      type: r.entity_type || "concept",
      title: r.title || r.id,
      score: Math.round(parseFloat(r.score) * 100) / 100,
      label: formatRelationshipLabel(r.relationship, !!r.relationship_is_reverse) || undefined,
    }));

    const selected = typeDiverseSelect(scored, limit);

    return c.json({
      entityId,
      related: selected,
      total: selected.length,
    });
  })

  // ---- GET /graph/:id ----

  .get("/graph/:id", async (c) => {
    const entityId = c.req.param("id");
    if (!entityId) return validationError(c, "Entity ID is required");

    const rawDb = getDb();
    const MAX_GRAPH_EDGES = 500;

    // Phase 4b: resolve slug to integer and query by source_id_int / target_id_int
    const graphDb = getDrizzleDb();
    const graphEntityIntId = await resolvePageIntId(graphDb, entityId);
    if (graphEntityIntId === null) {
      return c.json({ entityId, nodes: [], edges: [] });
    }

    // Get all direct links (both directions) for the entity.
    // This provides the raw graph data for visualization.
    const results = await rawDb<GraphEdgeDbRow[]>`
    SELECT
      ws.id AS source_id,
      wt.id AS target_id,
      pl.link_type,
      pl.relationship,
      pl.weight,
      ws.title AS source_title,
      ws.entity_type AS source_type,
      wt.title AS target_title,
      wt.entity_type AS target_type
    FROM page_links pl
    LEFT JOIN wiki_pages ws ON ws.integer_id = pl.source_id_int
    LEFT JOIN wiki_pages wt ON wt.integer_id = pl.target_id_int
    -- Exclude rows where either endpoint lacks an integer ID (would produce NULL node ids)
    WHERE pl.source_id_int IS NOT NULL AND pl.target_id_int IS NOT NULL
      AND (pl.source_id_int = ${graphEntityIntId} OR pl.target_id_int = ${graphEntityIntId})
    ORDER BY pl.weight DESC
    LIMIT ${MAX_GRAPH_EDGES}
  `;

    // Build node and edge sets
    const nodeMap = new Map<string, { id: string; type: string; title: string }>();
    const edges: Array<{
      source: string;
      target: string;
      linkType: string;
      relationship?: string;
      weight: number;
    }> = [];

    for (const r of results) {
      if (!nodeMap.has(r.source_id)) {
        nodeMap.set(r.source_id, {
          id: r.source_id,
          type: r.source_type || "concept",
          title: r.source_title || r.source_id,
        });
      }
      if (!nodeMap.has(r.target_id)) {
        nodeMap.set(r.target_id, {
          id: r.target_id,
          type: r.target_type || "concept",
          title: r.target_title || r.target_id,
        });
      }
      edges.push({
        source: r.source_id,
        target: r.target_id,
        linkType: r.link_type,
        relationship: r.relationship || undefined,
        weight: r.weight,
      });
    }

    return c.json({
      entityId,
      nodes: Array.from(nodeMap.values()),
      edges,
    });
  })

  // ---- GET /stats ----

  .get("/stats", async (c) => {
    const rawDb = getDb();

    const stats = await rawDb<LinkStatsRow[]>`
    SELECT
      link_type,
      COUNT(*)::int AS count,
      ROUND(AVG(weight)::numeric, 2) AS avg_weight
    FROM page_links
    GROUP BY link_type
    ORDER BY count DESC
  `;

    const totalResult = await rawDb<TotalRow[]>`
    SELECT COUNT(*)::int AS total FROM page_links
  `;

    const uniquePagesResult = await rawDb<UniqueCountRow[]>`
    SELECT COUNT(DISTINCT source_id_int)::int AS sources,
           COUNT(DISTINCT target_id_int)::int AS targets
    FROM page_links
  `;

    const total = totalResult[0]?.total || 0;
    const unique = uniquePagesResult[0];

    return c.json({
      total,
      uniqueSources: unique?.sources || 0,
      uniqueTargets: unique?.targets || 0,
      byType: stats.map((s) => ({
        linkType: s.link_type,
        count: s.count,
        avgWeight: parseFloat(s.avg_weight),
      })),
    });
  });

// ---- Helpers ----

/**
 * Format a relationship label, applying inverse if needed.
 *
 * In the related query, the relationship label comes from the source→target
 * direction of the yaml_related link. If the current entity is the target
 * (i.e., the link points TO us), we need the inverse label.
 *
 * @param relationship - Raw relationship string from DB
 * @param isReverse - Whether the link was found in the reverse direction
 */
function formatRelationshipLabel(
  relationship: string | null,
  isReverse: boolean
): string | null {
  if (!relationship || relationship === "related") return null;
  const label = isReverse
    ? INVERSE_LABEL[relationship] || relationship
    : relationship;
  return label.replace(/-/g, " ");
}

/**
 * Type-diverse selection: guarantees MIN_PER_TYPE entries from each entity type,
 * then fills remaining slots by score.
 */
function typeDiverseSelect(
  scored: Array<{ id: string; type: string; title: string; score: number; label?: string }>,
  maxItems: number
): typeof scored {
  const selected = new Set<string>();
  const byType = new Map<string, typeof scored>();

  for (const entry of scored) {
    if (!byType.has(entry.type)) byType.set(entry.type, []);
    byType.get(entry.type)!.push(entry);
  }

  // Phase 1: take top MIN_PER_TYPE from each type
  for (const [, entries] of byType) {
    for (const entry of entries.slice(0, MIN_PER_TYPE)) {
      selected.add(entry.id);
    }
  }

  // Phase 2: fill remaining slots by score
  for (const entry of scored) {
    if (selected.size >= maxItems) break;
    selected.add(entry.id);
  }

  // Build final list in score order
  return scored.filter((e) => selected.has(e.id)).slice(0, maxItems);
}

export const linksRoute = linksApp;
export type LinksRoute = typeof linksApp;
