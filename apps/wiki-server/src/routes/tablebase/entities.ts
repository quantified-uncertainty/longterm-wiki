import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, asc, sql, ilike, or, inArray, notInArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { logger } from "../../logger.js";
import { entities, facts, things } from "../../schema.js";
import { checkRefsExist } from "../shared/ref-check.js";
import {
  validationError,
  notFoundError,
  paginationQuery,
  escapeIlike,
  dbError,
  zv,
} from "../shared/utils.js";
import {
  SyncEntitySchema as SharedSyncEntitySchema,
  SyncEntitiesBatchSchema,
} from "../../api-types.js";
import { upsertThingsInTx } from "../shared/thing-sync.js";
import {
  buildSearchCondition,
  buildTsvectorSearchCondition,
  buildTsvectorRankExpr,
  buildTrigramFallbackCondition,
  buildTrigramRankExpr,
  parseSort,
  TRIGRAM_FALLBACK_THRESHOLD,
} from "../shared/query-helpers.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 500;

/** Maximum number of entities returned by the /directory endpoint. */
const DIRECTORY_MAX_ENTITIES = 2000;

/**
 * Valid entity type names accepted by the /directory endpoint.
 * Mirrors CANONICAL_ENTITY_TYPE_NAMES + ENTITY_TYPE_ALIAS_NAMES from
 * apps/web/src/data/entity-type-names.ts — keep in sync when adding types.
 */
const VALID_DIRECTORY_ENTITY_TYPES = new Set([
  // Canonical types
  "risk",
  "risk-factor",
  "capability",
  "safety-agenda",
  "approach",
  "project",
  "policy",
  "organization",
  "crux",
  "concept",
  "case-study",
  "person",
  "resource",
  "historical",
  "analysis",
  "parameter",
  "argument",
  "table",
  "diagram",
  "event",
  "debate",
  "overview",
  "intelligence-paradigm",
  "internal",
  "ai-model",
  "benchmark",
  "research-area",
  // TMC (AI Transition Model) types — bulk-imported, no YAML source
  "ai-transition-model-factor",
  "ai-transition-model-parameter",
  "ai-transition-model-scenario",
  "ai-transition-model-metric",
  "ai-transition-model-subitem",
  // Aliases (legacy / alternate names)
  "researcher",
  "lab",
  "lab-frontier",
  "lab-research",
  "lab-startup",
  "lab-academic",
  "funder",
  "safety-approaches",
  "policies",
  "concepts",
  "events",
  "models",
  "model",
]);

// ---- Schemas (from shared api-types) ----

const SyncEntitySchema = SharedSyncEntitySchema;
const SyncBatchSchema = SyncEntitiesBatchSchema;

const PaginationQuery = paginationQuery({ maxLimit: MAX_PAGE_SIZE }).extend({
  entityType: z.string().max(100).optional(),
});

const SearchQuery = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ---- Organizations query schema ----

const ORG_SORT_ALLOWED = ["name", "revenue", "valuation", "headcount", "totalFunding", "founded"] as const;

const OrganizationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().max(200).optional(),
  sort: z.string().max(50).optional(),
});

const DirectoryQuery = z.object({
  entityType: z.string().min(1).max(100),
  /** Comma-separated list of fact measures to include (e.g., "revenue,headcount") */
  measures: z.string().max(500).optional(),
  /** When "true", include stub entities (reference-only, no rich data). Default: exclude stubs. */
  includeStubs: z.enum(["true", "false"]).default("false"),
});

// ---- Helpers ----

/**
 * Build a parameterized SQL value list for use with `IN (...)`.
 *
 * Drizzle's `sql` tag expands JS arrays as value-lists `($1,$2,...)` which is
 * a row constructor — valid for `IN` but **not** for PostgreSQL `ANY()` (which
 * expects an array type). Use `IN (${sqlInList(arr)})` instead of
 * `= ANY(${arr})` in raw `db.execute()` queries.
 */
function sqlInList(values: string[]) {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

/**
 * Auto-clear the `stub` flag from entity metadata when the entity has been
 * enriched with data beyond the minimum (title, type, stableId).
 *
 * An entity is considered enriched if it has any of:
 *   - A non-empty description
 *   - Non-empty customFields array
 *   - Non-empty sources array
 *   - Non-empty relatedEntries array
 *   - A wikiId (wiki page assigned)
 *
 * Exported for testing.
 */
export function clearStubIfEnriched(entity: {
  description?: string | null;
  customFields?: unknown[] | null;
  sources?: unknown[] | null;
  relatedEntries?: unknown[] | null;
  wikiId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  const metadata = entity.metadata;
  if (!metadata || typeof metadata !== "object" || !metadata.stub) {
    return metadata ?? null;
  }

  const hasDescription = !!entity.description;
  const hasCustomFields = Array.isArray(entity.customFields) && entity.customFields.length > 0;
  const hasSources = Array.isArray(entity.sources) && entity.sources.length > 0;
  const hasRelatedEntries = Array.isArray(entity.relatedEntries) && entity.relatedEntries.length > 0;
  const hasWikiId = !!entity.wikiId;

  if (hasDescription || hasCustomFields || hasSources || hasRelatedEntries || hasWikiId) {
    const { stub: _, ...rest } = metadata;
    return Object.keys(rest).length > 0 ? rest : null;
  }

  return metadata;
}

function formatEntity(e: typeof entities.$inferSelect) {
  return {
    id: e.id,
    wikiId: e.wikiId,
    stableId: e.stableId,
    entityType: e.entityType,
    title: e.title,
    description: e.description,
    website: e.website,
    tags: e.tags,
    clusters: e.clusters,
    status: e.status,
    lastUpdated: e.lastUpdated,
    customFields: e.customFields,
    relatedEntries: e.relatedEntries,
    sources: e.sources,
    metadata: e.metadata,
    syncedAt: e.syncedAt,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

const entitiesApp = new Hono()

  // ---- GET /search?q=...&limit=20 ----

  .get("/search", zv("query", SearchQuery), async (c) => {
    const { q, limit } = c.req.valid("query");
    const db = getDrizzleDb();

    const searchVectorExpr = sql.raw("search_vector");
    const ftsCondition = buildTsvectorSearchCondition(
      searchVectorExpr,
      q,
      [entities.title, entities.id, entities.description],
    );

    const rankExpr = buildTsvectorRankExpr(
      searchVectorExpr,
      entities.title,
      q,
    );

    let rows;
    if (ftsCondition && rankExpr) {
      // Tsvector search with relevance ranking
      rows = await db
        .select()
        .from(entities)
        .where(ftsCondition)
        .orderBy(sql`${rankExpr} DESC`, entities.id)
        .limit(limit);

      // Trigram fallback if too few results
      if (rows.length < TRIGRAM_FALLBACK_THRESHOLD) {
        const trigramCondition = buildTrigramFallbackCondition(entities.title, q);
        const trigramRows = await db
          .select()
          .from(entities)
          .where(trigramCondition)
          .orderBy(sql`${buildTrigramRankExpr(entities.title, q)} DESC`, entities.id)
          .limit(limit);
        if (trigramRows.length > rows.length) {
          rows = trigramRows;
        }
      }
    } else {
      // ILIKE fallback when tsquery cannot be built
      const pattern = `%${escapeIlike(q)}%`;
      rows = await db
        .select()
        .from(entities)
        .where(
          or(
            ilike(entities.title, pattern),
            ilike(entities.id, pattern),
            ilike(entities.description, pattern)
          )
        )
        .orderBy(entities.id)
        .limit(limit);
    }

    return c.json({
      results: rows.map(formatEntity),
      query: q,
      total: rows.length,
    });
  })

  // ---- GET /stats ----

  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const totalResult = await db.select({ count: count() }).from(entities);
    const total = totalResult[0].count;

    const byType = await db
      .select({
        entityType: entities.entityType,
        count: count(),
      })
      .from(entities)
      .groupBy(entities.entityType)
      .orderBy(sql`count(*) DESC`);

    return c.json({
      total,
      byType: Object.fromEntries(
        byType.map((r) => [r.entityType, r.count])
      ),
    });
  })

  // ---- GET /organizations ----
  // Paginated list of organizations with latest financial facts.
  // Supports search (?q=), sort (?sort=revenue:desc), and pagination.
  .get("/organizations", zv("query", OrganizationsQuery), async (c) => {
    const { limit, offset, q, sort } = c.req.valid("query");
    const db = getDrizzleDb();

    // Build WHERE — always filter to organization entity type
    const conditions: SQL[] = [eq(entities.entityType, "organization")];

    // Search: prefer tsvector full-text search, fall back to ILIKE + trigram
    const searchVectorExpr = sql.raw("search_vector");
    let searchRankExpr: SQL | undefined;
    let searchMode: "fts" | "trigram" | null = null;

    if (q) {
      const ftsCondition = buildTsvectorSearchCondition(
        searchVectorExpr,
        q,
        [entities.title, entities.id, entities.description],
      );
      if (ftsCondition) {
        conditions.push(ftsCondition);
        searchRankExpr = buildTsvectorRankExpr(
          searchVectorExpr,
          entities.title,
          q,
        );
        searchMode = "fts";
      }
    }

    const where = conditions.length === 1 ? conditions[0] : and(...conditions)!;

    // Subquery for latest fact value by measure (property name).
    // Note: fact_id is the unique fact ID (e.g. "f_qR5tY9wE1a"),
    // measure is the property name (e.g. "revenue", "headcount").
    const latestFact = (measureName: string) => sql`(
      SELECT f.numeric
      FROM facts f
      WHERE f.entity_id = ${entities.stableId}
        AND f.measure = ${measureName}
        AND f.numeric IS NOT NULL
      ORDER BY f.as_of DESC NULLS LAST, f.id DESC
      LIMIT 1
    )`;

    const latestFactAsOf = (measureName: string) => sql`(
      SELECT f.as_of
      FROM facts f
      WHERE f.entity_id = ${entities.stableId}
        AND f.measure = ${measureName}
        AND f.numeric IS NOT NULL
      ORDER BY f.as_of DESC NULLS LAST, f.id DESC
      LIMIT 1
    )`;

    const latestFactText = (measureName: string) => sql`(
      SELECT COALESCE(f.value, CAST(f.numeric AS TEXT))
      FROM facts f
      WHERE f.entity_id = ${entities.stableId}
        AND f.measure = ${measureName}
      ORDER BY f.as_of DESC NULLS LAST, f.id DESC
      LIMIT 1
    )`;

    // Build ORDER BY
    const { field, dir } = parseSort(sort, ORG_SORT_ALLOWED, "name", "asc");
    const sortColMap: Record<string, SQL> = {
      name: sql`${entities.title}`,
      revenue: latestFact("revenue"),
      valuation: latestFact("valuation"),
      headcount: latestFact("headcount"),
      totalFunding: latestFact("total-funding"),
      founded: latestFactText("founded-date"),
    };
    const sortCol = sortColMap[field] ?? sql`${entities.title}`;
    const orderClause =
      dir === "desc"
        ? sql`${sortCol} DESC NULLS LAST`
        : sql`${sortCol} ASC NULLS LAST`;

    // When searching with relevance, override sort with search rank
    const effectiveOrder = (q && searchRankExpr && (sort === undefined || sort === ""))
      ? sql`${searchRankExpr} DESC, ${entities.title} ASC`
      : orderClause;

    // Filtered count
    const [{ total: ftsTotal }] = await db
      .select({ total: count() })
      .from(entities)
      .where(where);

    let total = ftsTotal;

    // Data query with lateral fact subqueries
    interface OrgRow {
      id: string;
      wikiId: string | null;
      stableId: string | null;
      title: string;
      description: string | null;
      website: string | null;
      revenueNum: number | null;
      revenueDate: string | null;
      valuationNum: number | null;
      valuationDate: string | null;
      headcount: number | null;
      headcountDate: string | null;
      totalFundingNum: number | null;
      foundedDate: string | null;
    }

    let rows: OrgRow[] = await db
      .select({
        id: entities.id,
        wikiId: entities.wikiId,
        stableId: entities.stableId,
        title: entities.title,
        description: entities.description,
        website: entities.website,
        revenueNum: sql<number | null>`${latestFact("revenue")}`,
        revenueDate: sql<string | null>`${latestFactAsOf("revenue")}`,
        valuationNum: sql<number | null>`${latestFact("valuation")}`,
        valuationDate: sql<string | null>`${latestFactAsOf("valuation")}`,
        headcount: sql<number | null>`${latestFact("headcount")}`,
        headcountDate: sql<string | null>`${latestFactAsOf("headcount")}`,
        totalFundingNum: sql<number | null>`${latestFact("total-funding")}`,
        foundedDate: sql<string | null>`${latestFactText("founded-date")}`,
      })
      .from(entities)
      .where(where)
      .orderBy(effectiveOrder, entities.id)
      .limit(limit)
      .offset(offset);

    // Trigram fallback: if FTS returned too few results and we have a search term,
    // retry with trigram similarity on title for typo tolerance.
    if (q && total < TRIGRAM_FALLBACK_THRESHOLD && searchMode === "fts") {
      searchMode = "trigram";
      const trigramConditions: SQL[] = [
        eq(entities.entityType, "organization"),
        buildTrigramFallbackCondition(entities.title, q),
      ];
      const trigramWhere = and(...trigramConditions)!;
      const trigramRank = buildTrigramRankExpr(entities.title, q);

      const [{ total: trigramTotal }] = await db
        .select({ total: count() })
        .from(entities)
        .where(trigramWhere);

      if (trigramTotal > total) {
        total = trigramTotal;
        rows = await db
          .select({
            id: entities.id,
            wikiId: entities.wikiId,
            stableId: entities.stableId,
            title: entities.title,
            description: entities.description,
            website: entities.website,
            revenueNum: sql<number | null>`${latestFact("revenue")}`,
            revenueDate: sql<string | null>`${latestFactAsOf("revenue")}`,
            valuationNum: sql<number | null>`${latestFact("valuation")}`,
            valuationDate: sql<string | null>`${latestFactAsOf("valuation")}`,
            headcount: sql<number | null>`${latestFact("headcount")}`,
            headcountDate: sql<string | null>`${latestFactAsOf("headcount")}`,
            totalFundingNum: sql<number | null>`${latestFact("total-funding")}`,
            foundedDate: sql<string | null>`${latestFactText("founded-date")}`,
          })
          .from(entities)
          .where(trigramWhere)
          .orderBy(sql`${trigramRank} DESC`, entities.id)
          .limit(limit)
          .offset(offset);
      }
    }

    return c.json({
      organizations: rows.map((r) => ({
        id: r.id,
        wikiId: r.wikiId,
        stableId: r.stableId,
        title: r.title,
        description: r.description,
        website: r.website,
        revenueNum: r.revenueNum != null ? Number(r.revenueNum) : null,
        revenueDate: r.revenueDate,
        valuationNum: r.valuationNum != null ? Number(r.valuationNum) : null,
        valuationDate: r.valuationDate,
        headcount: r.headcount != null ? Number(r.headcount) : null,
        headcountDate: r.headcountDate,
        totalFundingNum: r.totalFundingNum != null ? Number(r.totalFundingNum) : null,
        foundedDate: r.foundedDate,
      })),
      total,
      limit,
      offset,
      searchMode,
    });
  })

  // ---- GET /directory?entityType=organization&measures=revenue,headcount ----
  // Returns all entities of a type with their latest facts for directory pages.
  .get("/directory", zv("query", DirectoryQuery), async (c) => {
    const { entityType, measures, includeStubs } = c.req.valid("query");

    // Reject unknown entity types to prevent arbitrary string injection and
    // to surface misconfigured callers early.
    if (!VALID_DIRECTORY_ENTITY_TYPES.has(entityType)) {
      return c.json(
        { error: `Unknown entityType: "${entityType}". Must be one of the known entity types.` },
        400
      );
    }

    const db = getDrizzleDb();

    // Build metadata exclusion conditions:
    // - Always exclude deprecated entities
    // - Exclude stub entities by default (reference-only entities created by
    //   ensure-entities/create-entity that lack rich data). Stubs are needed as
    //   FK targets (personnel records) but should not appear in directory listings.
    //
    // Filtering approach: Person/org entities use `metadata.stub` flag because
    // stubs are created programmatically by CLI commands. The flag is auto-cleared
    // during sync when an entity gains enriched data (description, sources, etc.).
    // Research areas use data-presence checks (orgCount/paperCount) instead — see
    // getResearchAreasFromPG() in tablebase.ts for why the approaches differ.
    const metadataConditions = [
      or(
        sql`${entities.metadata} IS NULL`,
        sql`${entities.metadata}->>'deprecated' IS NULL`,
        sql`${entities.metadata}->>'deprecated' != 'true'`,
      ),
    ];

    if (includeStubs !== "true") {
      metadataConditions.push(
        or(
          sql`${entities.metadata} IS NULL`,
          sql`${entities.metadata}->>'stub' IS NULL`,
          sql`${entities.metadata}->>'stub' != 'true'`,
        ),
      );
    }

    // 1. Get all entities of the requested type (capped to prevent unbounded scans).
    //    Exclude deprecated and stub entities from directory listings by default.
    //    Both flags are stored in the metadata JSONB column.
    const entityRows = await db
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.entityType, entityType),
          ...metadataConditions,
        ),
      )
      .orderBy(asc(entities.title))
      .limit(DIRECTORY_MAX_ENTITIES);

    // 2. Get latest facts for these entities (if measures requested)
    const measureList = measures
      ? measures.split(",").map((m) => m.trim()).filter(Boolean)
      : [];

    type FactRow = {
      entityId: string | null;
      measure: string | null;
      factId: string;
      value: string | null;
      numeric: number | null;
      asOf: string | null;
      label: string | null;
      format: string | null;
      formatDivisor: number | null;
    };

    let factRows: FactRow[] = [];
    if (measureList.length > 0) {
      const stableIds = entityRows
        .map((e) => e.stableId)
        .filter((id): id is string => id != null);

      if (stableIds.length > 0) {
        // Get latest fact per entity per measure using DISTINCT ON
        factRows = await db.execute<FactRow>(sql`
          SELECT DISTINCT ON (f.entity_id, f.measure)
            f.entity_id AS "entityId",
            f.measure,
            f.fact_id AS "factId",
            f.value,
            f.numeric,
            f.as_of AS "asOf",
            f.label,
            f.format,
            f.format_divisor AS "formatDivisor"
          FROM facts f
          WHERE f.entity_id IN (${sqlInList(stableIds)})
            AND f.measure IN (${sqlInList(measureList)})
          ORDER BY f.entity_id, f.measure, f.as_of DESC NULLS LAST
        `);
      }
    }

    // 3. Build a map: stableId → { measure → fact }
    const factMap = new Map<string, Map<string, FactRow>>();
    for (const f of factRows) {
      if (!f.entityId) continue;
      let entityFacts = factMap.get(f.entityId);
      if (!entityFacts) {
        entityFacts = new Map();
        factMap.set(f.entityId, entityFacts);
      }
      if (f.measure && !entityFacts.has(f.measure)) {
        entityFacts.set(f.measure, f);
      }
    }

    // 4. Resolve ref-type fact values (entity IDs → names + slugs)
    // Collect all values that look like entity stable IDs (10-char alphanumeric)
    const refPattern = /^[a-zA-Z0-9]{10}$/;
    const refCandidates = new Set<string>();
    for (const entityFacts of factMap.values()) {
      for (const f of entityFacts.values()) {
        if (f.value && refPattern.test(f.value)) {
          refCandidates.add(f.value);
        }
      }
    }

    // Batch-resolve ref candidates to entity names and slugs
    const refResolutionMap = new Map<string, { name: string; entityId: string }>();
    if (refCandidates.size > 0) {
      const refIds = [...refCandidates];
      const refRows = await db
        .select({
          stableId: entities.stableId,
          title: entities.title,
          id: entities.id,
        })
        .from(entities)
        .where(inArray(entities.stableId, refIds));

      for (const r of refRows) {
        if (r.stableId) {
          refResolutionMap.set(r.stableId, { name: r.title, entityId: r.id });
        }
      }
    }

    // 5. Fetch domain table counts (personnel + grants)
    const stableIds = entityRows
      .map((e) => e.stableId)
      .filter((id): id is string => id != null);

    // Personnel counts: person_entity_id → count (career history entries)
    const personnelCountMap = new Map<string, number>();
    if (stableIds.length > 0) {
      type PersonnelCountRow = { personId: string; cnt: number };
      const personnelCounts = await db.execute<PersonnelCountRow>(sql`
        SELECT person_entity_id AS "personId", COUNT(*)::int AS cnt
        FROM personnel
        WHERE person_entity_id IN (${sqlInList(stableIds)})
          AND role_type = 'career'
        GROUP BY person_entity_id
      `);
      for (const r of personnelCounts) {
        personnelCountMap.set(r.personId, r.cnt);
      }
    }

    // Grant counts: org_entity_id → grantsGiven, grantee_entity_id → grantsReceived
    const grantsGivenMap = new Map<string, number>();
    const grantsReceivedMap = new Map<string, number>();
    if (stableIds.length > 0) {
      type GrantCountRow = { entityId: string; cnt: number };
      const grantsGiven = await db.execute<GrantCountRow>(sql`
        SELECT org_entity_id AS "entityId", COUNT(*)::int AS cnt
        FROM grants
        WHERE org_entity_id IN (${sqlInList(stableIds)})
        GROUP BY org_entity_id
      `);
      for (const r of grantsGiven) {
        grantsGivenMap.set(r.entityId, r.cnt);
      }

      const grantsReceived = await db.execute<GrantCountRow>(sql`
        SELECT grantee_entity_id AS "entityId", COUNT(*)::int AS cnt
        FROM grants
        WHERE grantee_entity_id IN (${sqlInList(stableIds)})
        GROUP BY grantee_entity_id
      `);
      for (const r of grantsReceived) {
        grantsReceivedMap.set(r.entityId, r.cnt);
      }
    }

    // 6. Build response
    const items = entityRows.map((e) => {
      const entityFacts = e.stableId ? factMap.get(e.stableId) : undefined;
      const factsObj: Record<string, {
        value: string | null;
        numeric: number | null;
        asOf: string | null;
        label: string | null;
        format: string | null;
        formatDivisor: number | null;
      }> = {};

      // Build resolvedRefs for this entity's facts
      const resolvedRefs: Record<string, { name: string; entityId: string }> = {};

      if (entityFacts) {
        for (const [measure, f] of entityFacts) {
          factsObj[measure] = {
            value: f.value,
            numeric: f.numeric,
            asOf: f.asOf,
            label: f.label,
            format: f.format,
            formatDivisor: f.formatDivisor,
          };

          // If this fact's value resolved to an entity, include it
          if (f.value && refResolutionMap.has(f.value)) {
            resolvedRefs[measure] = refResolutionMap.get(f.value)!;
          }
        }
      }

      const sid = e.stableId;
      const counts = {
        careerHistory: sid ? (personnelCountMap.get(sid) ?? 0) : 0,
        grantsGiven: sid ? (grantsGivenMap.get(sid) ?? 0) : 0,
        grantsReceived: sid ? (grantsReceivedMap.get(sid) ?? 0) : 0,
      };

      return {
        id: e.id,
        wikiId: e.wikiId,
        stableId: e.stableId,
        entityType: e.entityType,
        title: e.title,
        description: e.description,
        website: e.website,
        metadata: e.metadata,
        tags: e.tags,
        facts: factsObj,
        resolvedRefs,
        counts,
      };
    });

    return c.json({ entities: items, total: items.length });
  })

  // ---- GET /:id ----

  .get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return validationError(c, "Entity ID is required");

    const db = getDrizzleDb();

    // Look up by slug, wiki ID, or stable ID
    const rows = await db
      .select()
      .from(entities)
      .where(or(eq(entities.id, id), eq(entities.wikiId, id), eq(entities.stableId, id)));

    if (rows.length === 0) {
      return notFoundError(c, `No entity found for id: ${id}`);
    }

    return c.json(formatEntity(rows[0]));
  })

  // ---- GET / (paginated listing) ----

  .get("/", zv("query", PaginationQuery), async (c) => {
    const { limit, offset, entityType } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (entityType) conditions.push(eq(entities.entityType, entityType));

    const whereClause =
      conditions.length > 0
        ? conditions.length === 1
          ? conditions[0]
          : and(...conditions)
        : undefined;

    const rows = await db
      .select({
        id: entities.id,
        wikiId: entities.wikiId,
        stableId: entities.stableId,
        entityType: entities.entityType,
        title: entities.title,
        description: entities.description,
        website: entities.website,
        tags: entities.tags,
        status: entities.status,
        lastUpdated: entities.lastUpdated,
      })
      .from(entities)
      .where(whereClause)
      .orderBy(asc(entities.id))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(entities)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({ entities: rows, total, limit, offset });
  })

  // ---- POST /sync ----

  .post("/sync", zv("json", SyncBatchSchema), async (c) => {
    const { entities: items } = c.req.valid("json");
    const db = getDrizzleDb();


    // Validate relatedEntries references: strip out references to entities
    // that don't exist (either in this batch or in PG). This allows the sync
    // to proceed even when entities reference each other across batches.
    const batchIds = new Set(items.map((e) => e.id));
    const relatedIds = [
      ...new Set(
        items
          .flatMap((e) => e.relatedEntries ?? [])
          .map((r) => r.id)
          .filter((id) => !batchIds.has(id))
      ),
    ];
    if (relatedIds.length > 0) {
      const missing = await checkRefsExist(db, entities, entities.id, relatedIds);
      if (missing.length > 0) {
        const missingSet = new Set(missing);
        // Strip invalid references instead of rejecting the batch
        for (const item of items) {
          if (item.relatedEntries) {
            item.relatedEntries = item.relatedEntries.filter(
              (r) => batchIds.has(r.id) || !missingSet.has(r.id)
            );
          }
        }
        console.warn(
          `[entities/sync] Stripped ${missing.length} unresolved relatedEntries refs: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` ... (+${missing.length - 10} more)` : ""}`
        );
      }
    }

    let upserted = 0;

    try {
      await db.transaction(async (tx) => {
        // Increase statement_timeout for bulk sync — default 30s is too tight
        // for batches of 100 entities with FK cascade checks on referencing tables.
        await tx.execute(sql`SET LOCAL statement_timeout = '120000'`); // 2 min
        const allVals = items.map((e) => ({
          id: e.id,
          wikiId: e.wikiId ?? null,
          stableId: e.stableId, // PK — always required
          entityType: e.entityType,
          title: e.title,
          description: e.description ?? null,
          website: e.website ?? null,
          tags: e.tags ?? null,
          clusters: e.clusters ?? null,
          status: e.status ?? null,
          lastUpdated: e.lastUpdated ?? null,
          customFields: e.customFields ?? null,
          relatedEntries: e.relatedEntries ?? null,
          sources: e.sources ?? null,
          metadata: clearStubIfEnriched(e),
        }));

        // Two-phase upsert to avoid unique constraint on `id` (slug) when a slug
        // was reassigned to a different stableId. Single INSERT ON CONFLICT (stableId)
        // can't handle this because the `id` unique violation fires first.
        //
        // Phase 1: Update existing entities by stableId (handles slug changes)
        // Phase 2: Insert new entities (stableId doesn't exist yet)
        const existingRows = await tx
          .select({ stableId: entities.stableId })
          .from(entities)
          .where(inArray(entities.stableId, allVals.map((v) => v.stableId)));
        const existingSet = new Set(existingRows.map((r) => r.stableId));

        // Phase 1: Update existing
        for (const val of allVals) {
          if (!existingSet.has(val.stableId)) continue;
          await tx
            .update(entities)
            .set({
              id: val.id,
              wikiId: val.wikiId ?? null,
              entityType: val.entityType,
              title: val.title,
              description: val.description ?? null,
              website: val.website ?? null,
              tags: val.tags ?? null,
              clusters: val.clusters ?? null,
              status: val.status ?? null,
              lastUpdated: val.lastUpdated ?? null,
              customFields: val.customFields ?? null,
              relatedEntries: val.relatedEntries ?? null,
              sources: val.sources ?? null,
              metadata: val.metadata ?? null,
              syncedAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(eq(entities.stableId, val.stableId));
        }

        // Phase 2: Insert new entities
        const newVals = allVals.filter((v) => !existingSet.has(v.stableId));
        if (newVals.length > 0) {
          // Before inserting, clear any slug conflicts from entities that were
          // deleted/renamed but left stale rows
          const newSlugs = newVals.map((v) => v.id);
          await tx
            .delete(entities)
            .where(inArray(entities.id, newSlugs));
          await tx.insert(entities).values(newVals);
        }

        // Dual-write to things table
        await upsertThingsInTx(
          tx,
          items.map((e) => ({
            id: e.stableId || e.id,
            thingType: "entity" as const,
            title: e.title,
            sourceTable: "entities",
            sourceId: e.id,
            entityType: e.entityType,
            description: e.description,
            wikiId: e.wikiId,
            sourceUrl: e.website,
          }))
        );

        upserted = allVals.length;
      });
    } catch (err) {
      // Detailed error logging — the dbError response was missing detail field
      const errMsg = err instanceof Error ? err.message : String(err);
      const errCause = err instanceof Error && err.cause
        ? (err.cause instanceof Error ? err.cause.message : String(err.cause))
        : "no-cause";
      const errName = err instanceof Error ? err.constructor.name : typeof err;
      const entityIds = items.map((e) => e.id).join(", ");
      logger.error({
        errName,
        errMsg,
        errCause,
        entityCount: items.length,
        entityIds: entityIds.slice(0, 500),
        stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
      }, "entities sync DETAILED error");
      // Return the detail inline so we can see it in the sync client
      return c.json({
        error: "database_error",
        message: `entities sync failed`,
        detail: `${errName}: ${errMsg}`,
        cause: errCause,
      }, 500);
    }

    return c.json({ upserted });
  })

  // ---- POST /prune ----
  // Remove stale entity records from PG that are no longer in the YAML source.
  // Accepts a list of canonical IDs that should be kept; deletes all others of the
  // specified entity type. Also cleans up corresponding things table entries.

  .post(
    "/prune",
    zv(
      "json",
      z.object({
        entityType: z.string().min(1).max(100),
        keepIds: z.array(z.string().min(1).max(500)).min(0).max(5000),
      })
    ),
    async (c) => {
      const { entityType, keepIds } = c.req.valid("json");

      if (!VALID_DIRECTORY_ENTITY_TYPES.has(entityType)) {
        return c.json(
          { error: `Unknown entityType: "${entityType}".` },
          400
        );
      }

      const db = getDrizzleDb();

      // Find stale entities: same type but ID not in the keep list.
      // When keepIds is empty, all entities of this type are stale.
      const staleRows = await db
        .select({ id: entities.id })
        .from(entities)
        .where(
          keepIds.length > 0
            ? and(
                eq(entities.entityType, entityType),
                notInArray(entities.id, keepIds),
              )
            : eq(entities.entityType, entityType)
        );

      if (staleRows.length === 0) {
        return c.json({ deleted: 0, ids: [] });
      }

      const staleIds = staleRows.map((r) => r.id);

      // Log before deleting (destructive operation)
      logger.info(
        { entityType, count: staleIds.length, ids: staleIds },
        `Deleting ${staleIds.length} stale ${entityType} entities`
      );

      try {
        await db.transaction(async (tx) => {
          // Delete from things table first (references entities via source_id)
          await tx
            .delete(things)
            .where(
              and(
                eq(things.sourceTable, "entities"),
                inArray(things.sourceId, staleIds),
              )
            );

          // Delete stale entities
          await tx
            .delete(entities)
            .where(inArray(entities.id, staleIds));
        });
      } catch (err) {
        return dbError(c, "entities prune", err, { entityType, count: staleIds.length });
      }

      return c.json({ deleted: staleIds.length, ids: staleIds });
    }
  );

export const entitiesRoute = entitiesApp;
export type EntitiesRoute = typeof entitiesApp;
