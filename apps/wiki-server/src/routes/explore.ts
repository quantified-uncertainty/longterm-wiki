import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db.js";
import { validationError } from "./utils.js";
import {
  buildPrefixTsquery,
  TRIGRAM_SIMILARITY_THRESHOLD,
} from "../search-utils.js";

export const exploreRoute = new Hono();

// ---- Query Schema ----

const ExploreQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().max(500).optional(),
  entityType: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  cluster: z.string().max(100).optional(),
  riskCategory: z.string().max(50).optional(),
  sort: z
    .enum([
      "recommended",
      "quality",
      "readerImportance",
      "researchImportance",
      "tacticalValue",
      "recentlyEdited",
      "recentlyCreated",
      "wordCount",
      "title",
    ])
    .default("recommended"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

// Category-to-type mapping (matches CATEGORY_TO_TYPE in data/index.ts)
const CATEGORY_TO_TYPE: Record<string, string> = {
  responses: "approach",
  organizations: "organization",
  people: "person",
  factors: "model",
  "intelligence-paradigms": "capability",
  models: "model",
  scenarios: "model",
  reports: "analysis",
  cruxes: "crux",
  worldviews: "concept",
  risks: "risk",
  forecasting: "model",
  "foundation-models": "capability",
  incidents: "historical",
  other: "concept",
};

// ---- Helpers ----

function parseTags(tagsStr: string | null): string[] {
  if (!tagsStr) return [];
  try {
    const parsed = JSON.parse(tagsStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseClusters(clustersVal: unknown | null): string[] {
  if (!clustersVal) return [];
  if (Array.isArray(clustersVal)) return clustersVal;
  if (typeof clustersVal === "string") {
    try {
      const parsed = JSON.parse(clustersVal);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Derive the explore item "type" from content_format and entity_type,
 * matching the logic in getExploreItems().
 */
function deriveType(
  contentFormat: string | null,
  entityType: string | null,
  category: string | null
): string {
  if (contentFormat === "table") return "table";
  if (contentFormat === "diagram") return "diagram";
  if (entityType) return entityType;
  if (category && CATEGORY_TO_TYPE[category]) return CATEGORY_TO_TYPE[category];
  return "concept";
}

/** Base conditions shared by all queries (excludes stubs, schema, internal, ai-transition-model). */
const BASE_CONDITIONS = `
  wp.word_count > 0
  AND wp.category != 'schema'
  AND wp.category != 'internal'
  AND (wp.entity_type IS NULL OR wp.entity_type NOT LIKE 'ai-transition-model%')
`;

/** The derived type expression used for grouping and filtering. */
const DERIVED_TYPE_EXPR = `
  CASE
    WHEN wp.content_format = 'table' THEN 'table'
    WHEN wp.content_format = 'diagram' THEN 'diagram'
    WHEN wp.entity_type IS NOT NULL THEN wp.entity_type
    ELSE 'concept'
  END
`;

/**
 * Build parameterized conditions and collect params.
 * Returns { conditions: string[], params: unknown[], paramIdx: number }.
 */
function buildFilterConditions(opts: {
  search?: string;
  cluster?: string;
  category?: string;
  entityType?: string;
  riskCategory?: string;
  startParamIdx?: number;
}): { conditions: string[]; params: unknown[]; paramIdx: number } {
  const conditions: string[] = [BASE_CONDITIONS];
  const params: unknown[] = [];
  let paramIdx = opts.startParamIdx ?? 1;

  if (opts.search) {
    const prefixQuery = buildPrefixTsquery(opts.search);
    if (prefixQuery) {
      conditions.push(
        `wp.search_vector @@ to_tsquery('english', $${paramIdx})`
      );
      params.push(prefixQuery);
      paramIdx++;
    }
  }

  if (opts.cluster) {
    conditions.push(`wp.clusters @> $${paramIdx}::jsonb`);
    params.push(JSON.stringify([opts.cluster]));
    paramIdx++;
  }

  if (opts.category) {
    conditions.push(`wp.category = $${paramIdx}`);
    params.push(opts.category);
    paramIdx++;
  }

  if (opts.entityType) {
    // entityType filter uses the derived type expression
    conditions.push(`(${DERIVED_TYPE_EXPR}) = $${paramIdx}`);
    params.push(opts.entityType);
    paramIdx++;
  }

  if (opts.riskCategory) {
    conditions.push(`wp.risk_category = $${paramIdx}`);
    params.push(opts.riskCategory);
    paramIdx++;
  }

  return { conditions, params, paramIdx };
}

// Sort column mapping
const SORT_COLUMNS: Record<string, string> = {
  recommended: "wp.recommended_score",
  quality: "wp.quality",
  readerImportance: "wp.reader_importance",
  researchImportance: "wp.research_importance",
  tacticalValue: "wp.tactical_value",
  recentlyEdited: "wp.last_updated",
  recentlyCreated: "wp.date_created",
  wordCount: "wp.word_count",
  title: "wp.title",
};

// ---- GET / (explore items with pagination, filtering, sorting, search, facets) ----

exploreRoute.get("/", async (c) => {
  const parsed = ExploreQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const {
    limit,
    offset,
    search,
    entityType,
    category,
    cluster,
    riskCategory,
    sort,
    sortDir,
  } = parsed.data;
  const rawDb = getDb();

  // Build main query conditions (all filters applied)
  const main = buildFilterConditions({
    search,
    cluster,
    category,
    entityType,
    riskCategory,
  });
  const mainWhere = `WHERE ${main.conditions.join(" AND ")}`;

  // Sort
  const col = SORT_COLUMNS[sort] || SORT_COLUMNS.recommended;
  const dir = sort === "title" ? "ASC" : sortDir.toUpperCase();
  const nullsLast = dir === "DESC" ? "NULLS LAST" : "NULLS FIRST";

  let searchRankSelect = "";
  let orderBy = `${col} ${dir} ${nullsLast}`;

  if (search) {
    const prefixQuery = buildPrefixTsquery(search);
    if (prefixQuery) {
      searchRankSelect = `, ts_rank_cd(wp.search_vector, to_tsquery('english', $1), 1) AS search_rank`;
      if (sort === "recommended") {
        orderBy = `search_rank DESC, ${col} ${dir} ${nullsLast}`;
      }
    }
  }

  // Main data query
  const limitParamIdx = main.paramIdx;
  const offsetParamIdx = main.paramIdx + 1;
  const dataParams = [...main.params, limit, offset];

  const dataQuery = `
    SELECT
      wp.id, wp.numeric_id, wp.title, wp.entity_type, wp.content_format,
      wp.category, COALESCE(wp.llm_summary, wp.description) AS description,
      wp.tags AS page_tags, wp.clusters AS page_clusters,
      wp.word_count, wp.quality, wp.reader_importance, wp.research_importance,
      wp.tactical_value, wp.backlink_count, wp.risk_category,
      wp.last_updated, wp.date_created, wp.recommended_score,
      e.tags AS entity_tags, e.clusters AS entity_clusters
      ${searchRankSelect}
    FROM wiki_pages wp
    LEFT JOIN entities e ON wp.id = e.id
    ${mainWhere}
    ORDER BY ${orderBy}
    LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
  `;

  // Count query (same filters, no pagination)
  const countQuery = `
    SELECT count(*) AS total
    FROM wiki_pages wp
    ${mainWhere}
  `;

  // Faceted counts — cascading:
  // 1. Cluster counts: search only
  // 2. Category counts: search + cluster
  // 3. Entity type counts: search + cluster + category
  // 4. Risk category counts: search + cluster + category + entity_type in risk types

  const searchOnly = buildFilterConditions({ search });
  const searchCluster = buildFilterConditions({ search, cluster });
  const searchClusterCat = buildFilterConditions({ search, cluster, category });
  const searchClusterCatRisk = buildFilterConditions({
    search,
    cluster,
    category,
    entityType: entityType === "risk" ? undefined : entityType,
  });

  const clusterCountQuery = `
    SELECT val, count(*) AS cnt
    FROM wiki_pages wp, jsonb_array_elements_text(wp.clusters) AS val
    WHERE ${searchOnly.conditions.join(" AND ")}
    GROUP BY val ORDER BY cnt DESC
  `;

  const categoryCountQuery = `
    SELECT wp.category AS val, count(*) AS cnt
    FROM wiki_pages wp
    WHERE ${searchCluster.conditions.join(" AND ")} AND wp.category IS NOT NULL
    GROUP BY wp.category ORDER BY cnt DESC
  `;

  const entityTypeCountQuery = `
    SELECT (${DERIVED_TYPE_EXPR}) AS val, count(*) AS cnt
    FROM wiki_pages wp
    WHERE ${searchClusterCat.conditions.join(" AND ")}
    GROUP BY val ORDER BY cnt DESC
  `;

  const riskCatCountQuery = `
    SELECT wp.risk_category AS val, count(*) AS cnt
    FROM wiki_pages wp
    WHERE ${searchClusterCatRisk.conditions.join(" AND ")}
      AND wp.entity_type = 'risk' AND wp.risk_category IS NOT NULL
    GROUP BY wp.risk_category ORDER BY cnt DESC
  `;

  // Execute all queries in parallel
  let [rows, countResult, clusterCounts, categoryCounts, entityTypeCounts, riskCatCounts] =
    await Promise.all([
      rawDb.unsafe(dataQuery, dataParams as any[]),
      rawDb.unsafe(countQuery, main.params as any[]),
      rawDb.unsafe(clusterCountQuery, searchOnly.params as any[]),
      rawDb.unsafe(categoryCountQuery, searchCluster.params as any[]),
      rawDb.unsafe(entityTypeCountQuery, searchClusterCat.params as any[]),
      rawDb.unsafe(riskCatCountQuery, searchClusterCatRisk.params as any[]),
    ]);

  let total = parseInt(countResult[0]?.total ?? "0", 10);

  // Trigram fallback: if FTS returned nothing and we have a search term,
  // fall back to pg_trgm similarity on title for typo tolerance.
  let searchMode: "fts" | "trigram" | null = search ? "fts" : null;
  if (search && total === 0) {
    searchMode = "trigram";
    // Build trigram fallback query with same non-search filters
    const noSearchFilters = buildFilterConditions({
      cluster,
      category,
      entityType,
      riskCategory,
    });
    const trigramParamIdx = noSearchFilters.paramIdx;
    const trigramWhere = `WHERE ${noSearchFilters.conditions.join(" AND ")} AND similarity(wp.title, $${trigramParamIdx}) > ${TRIGRAM_SIMILARITY_THRESHOLD}`;
    const trigramParams = [...noSearchFilters.params, search, limit, offset];

    const trigramQuery = `
      SELECT
        wp.id, wp.numeric_id, wp.title, wp.entity_type, wp.content_format,
        wp.category, COALESCE(wp.llm_summary, wp.description) AS description,
        wp.tags AS page_tags, wp.clusters AS page_clusters,
        wp.word_count, wp.quality, wp.reader_importance, wp.research_importance,
        wp.tactical_value, wp.backlink_count, wp.risk_category,
        wp.last_updated, wp.date_created, wp.recommended_score,
        e.tags AS entity_tags, e.clusters AS entity_clusters,
        similarity(wp.title, $${trigramParamIdx}) AS search_rank
      FROM wiki_pages wp
      LEFT JOIN entities e ON wp.id = e.id
      ${trigramWhere}
      ORDER BY similarity(wp.title, $${trigramParamIdx}) DESC
      LIMIT $${trigramParamIdx + 1} OFFSET $${trigramParamIdx + 2}
    `;
    const trigramCountQuery = `
      SELECT count(*) AS total FROM wiki_pages wp ${trigramWhere}
    `;

    const [trigramRows, trigramCount] = await Promise.all([
      rawDb.unsafe(trigramQuery, trigramParams as any[]),
      rawDb.unsafe(trigramCountQuery, [...noSearchFilters.params, search] as any[]),
    ]);
    rows = trigramRows;
    total = parseInt(trigramCount[0]?.total ?? "0", 10);
  }

  // Transform rows to ExploreItem shape
  const items = rows.map((r: any) => {
    const entityTags = Array.isArray(r.entity_tags) ? r.entity_tags : [];
    const pageTags = parseTags(r.page_tags);
    const tags = entityTags.length > 0 ? entityTags : pageTags;

    const entityClusters = parseClusters(r.entity_clusters);
    const pageClusters = parseClusters(r.page_clusters);
    const clusters =
      pageClusters.length > 0 ? pageClusters : entityClusters;

    return {
      id: r.id,
      numericId: r.numeric_id || r.id,
      title: r.title,
      type: deriveType(r.content_format, r.entity_type, r.category),
      description: r.description || null,
      tags,
      clusters,
      wordCount: r.word_count ?? null,
      quality: r.quality ?? null,
      readerImportance: r.reader_importance ?? null,
      researchImportance: r.research_importance ?? null,
      tacticalValue: r.tactical_value ?? null,
      backlinkCount: r.backlink_count ?? null,
      category: r.category || null,
      riskCategory: r.risk_category || null,
      lastUpdated: r.last_updated || null,
      dateCreated: r.date_created || null,
      contentFormat: r.content_format || null,
      recommendedScore: r.recommended_score ?? null,
    };
  });

  const toCountMap = (rows: any[]) =>
    Object.fromEntries(rows.map((r: any) => [r.val, parseInt(r.cnt, 10)]));

  return c.json({
    items,
    total,
    limit,
    offset,
    searchMode,
    facets: {
      clusters: toCountMap(clusterCounts),
      categories: toCountMap(categoryCounts),
      entityTypes: toCountMap(entityTypeCounts),
      riskCategories: toCountMap(riskCatCounts),
    },
  });
});
