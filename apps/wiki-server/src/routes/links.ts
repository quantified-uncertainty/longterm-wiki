import { Hono } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { getDrizzleDb, getDb } from "../db.js";
import { pageLinks } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "./utils.js";

export const linksRoute = new Hono();

// ---- Constants ----

const MAX_BATCH_SIZE = 5000; // Links are small rows; builds produce many
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

// ---- Schemas ----

const LinkSchema = z.object({
  sourceId: z.string().min(1).max(300),
  targetId: z.string().min(1).max(300),
  linkType: z.enum([
    "yaml_related",
    "entity_link",
    "name_prefix",
    "similarity",
    "shared_tag",
  ]),
  relationship: z.string().max(100).nullable().optional(),
  weight: z.number().min(0).max(100).default(1.0),
});

const SyncBatchSchema = z.object({
  links: z.array(LinkSchema).min(1).max(MAX_BATCH_SIZE),
  /** If true, delete all existing links before inserting (full replace). */
  replace: z.boolean().optional().default(false),
});

const BacklinksQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const RelatedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(MAX_RELATED),
});

// ---- POST /sync ----

linksRoute.post("/sync", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = SyncBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { links, replace } = parsed.data;
  const db = getDrizzleDb();

  let upserted = 0;

  await db.transaction(async (tx) => {
    if (replace) {
      await tx.delete(pageLinks);
    }

    // Batch upsert — on conflict (source, target, type) update weight + relationship
    for (let i = 0; i < links.length; i += 500) {
      const batch = links.slice(i, i + 500);
      const vals = batch.map((link) => ({
        sourceId: link.sourceId,
        targetId: link.targetId,
        linkType: link.linkType,
        relationship: link.relationship ?? null,
        weight: link.weight,
      }));

      await tx
        .insert(pageLinks)
        .values(vals)
        .onConflictDoUpdate({
          target: [pageLinks.sourceId, pageLinks.targetId, pageLinks.linkType],
          set: {
            weight: sql`excluded.weight`,
            relationship: sql`excluded.relationship`,
          },
        });

      upserted += vals.length;
    }
  });

  return c.json({ upserted });
});

// ---- GET /backlinks/:id ----

linksRoute.get("/backlinks/:id", async (c) => {
  const targetId = c.req.param("id");
  if (!targetId) return validationError(c, "Entity ID is required");

  const parsed = BacklinksQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit } = parsed.data;
  const rawDb = getDb();

  // Find all pages/entities that link TO this target.
  // Join with wiki_pages to get title and entity_type for the source.
  // Deduplicate by source_id (a source may link via multiple link_types),
  // then order by weight descending (most relevant first).
  const results = await rawDb`
    SELECT * FROM (
      SELECT DISTINCT ON (pl.source_id)
        pl.source_id,
        pl.link_type,
        pl.relationship,
        pl.weight,
        wp.title AS source_title,
        wp.entity_type AS source_type
      FROM page_links pl
      LEFT JOIN wiki_pages wp ON wp.id = pl.source_id
      WHERE pl.target_id = ${targetId}
      ORDER BY pl.source_id, pl.weight DESC
    ) sub
    ORDER BY sub.weight DESC
    LIMIT ${limit}
  `;

  const backlinks = results.map((r: any) => ({
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
});

// ---- GET /related/:id ----

linksRoute.get("/related/:id", async (c) => {
  const entityId = c.req.param("id");
  if (!entityId) return validationError(c, "Entity ID is required");

  const parsed = RelatedQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit } = parsed.data;
  const rawDb = getDb();

  // Compute related pages by aggregating all link signals bidirectionally.
  // For each neighbor, sum the weights of all link types connecting them.
  // Apply quality boost: 1 + quality/40 + reader_importance/400 (max ~1.45x).
  // Relationship labels come from yaml_related links.
  const results = await rawDb`
    WITH bidirectional_links AS (
      -- Forward links: entityId is source (is_reverse = false)
      SELECT target_id AS neighbor_id, link_type, relationship, weight, false AS is_reverse
      FROM page_links
      WHERE source_id = ${entityId}
      UNION ALL
      -- Reverse links: entityId is target (is_reverse = true)
      SELECT source_id AS neighbor_id, link_type, relationship, weight, true AS is_reverse
      FROM page_links
      WHERE target_id = ${entityId}
    ),
    aggregated AS (
      SELECT
        bl.neighbor_id,
        SUM(bl.weight) AS raw_score,
        -- Pick the first non-null relationship label (from yaml_related)
        (SELECT bl2.relationship
         FROM bidirectional_links bl2
         WHERE bl2.neighbor_id = bl.neighbor_id
           AND bl2.relationship IS NOT NULL
           AND bl2.link_type = 'yaml_related'
         LIMIT 1
        ) AS relationship,
        -- Track direction of the yaml_related link for label inversion
        (SELECT bl2.is_reverse
         FROM bidirectional_links bl2
         WHERE bl2.neighbor_id = bl.neighbor_id
           AND bl2.relationship IS NOT NULL
           AND bl2.link_type = 'yaml_related'
         LIMIT 1
        ) AS relationship_is_reverse
      FROM bidirectional_links bl
      WHERE bl.neighbor_id != ${entityId}
      GROUP BY bl.neighbor_id
    )
    SELECT
      a.neighbor_id AS id,
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
    LEFT JOIN wiki_pages wp ON wp.id = a.neighbor_id
    WHERE a.raw_score * (1.0 + COALESCE(wp.quality, 5)::real / 40.0
                             + COALESCE(wp.reader_importance, 50)::real / 400.0) >= ${MIN_SCORE}
    ORDER BY score DESC
    LIMIT ${limit * 3}
  `;

  // Type-diverse selection: guarantee MIN_PER_TYPE from each entity type,
  // then fill remaining slots with highest-scoring entries.
  const scored = results.map((r: any) => ({
    id: r.id as string,
    type: (r.entity_type as string) || "concept",
    title: (r.title as string) || r.id,
    score: Math.round(parseFloat(r.score) * 100) / 100,
    label: formatRelationshipLabel(r.relationship, !!r.relationship_is_reverse) || undefined,
  }));

  const selected = typeDiverseSelect(scored, limit);

  return c.json({
    entityId,
    related: selected,
    total: selected.length,
  });
});

// ---- GET /graph/:id ----

linksRoute.get("/graph/:id", async (c) => {
  const entityId = c.req.param("id");
  if (!entityId) return validationError(c, "Entity ID is required");

  const rawDb = getDb();
  const MAX_GRAPH_EDGES = 500;

  // Get all direct links (both directions) for the entity.
  // This provides the raw graph data for visualization.
  const results = await rawDb`
    SELECT
      pl.source_id,
      pl.target_id,
      pl.link_type,
      pl.relationship,
      pl.weight,
      ws.title AS source_title,
      ws.entity_type AS source_type,
      wt.title AS target_title,
      wt.entity_type AS target_type
    FROM page_links pl
    LEFT JOIN wiki_pages ws ON ws.id = pl.source_id
    LEFT JOIN wiki_pages wt ON wt.id = pl.target_id
    WHERE pl.source_id = ${entityId} OR pl.target_id = ${entityId}
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

  for (const r of results as any[]) {
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
});

// ---- GET /stats ----

linksRoute.get("/stats", async (c) => {
  const rawDb = getDb();

  const stats = await rawDb`
    SELECT
      link_type,
      COUNT(*)::int AS count,
      ROUND(AVG(weight)::numeric, 2) AS avg_weight
    FROM page_links
    GROUP BY link_type
    ORDER BY count DESC
  `;

  const totalResult = await rawDb`
    SELECT COUNT(*)::int AS total FROM page_links
  `;

  const uniquePagesResult = await rawDb`
    SELECT COUNT(DISTINCT source_id)::int AS sources,
           COUNT(DISTINCT target_id)::int AS targets
    FROM page_links
  `;

  return c.json({
    total: (totalResult[0] as any)?.total || 0,
    uniqueSources: (uniquePagesResult[0] as any)?.sources || 0,
    uniqueTargets: (uniquePagesResult[0] as any)?.targets || 0,
    byType: stats.map((s: any) => ({
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
