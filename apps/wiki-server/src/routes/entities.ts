import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, asc, sql, ilike, or, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { entities, facts } from "../schema.js";
import { checkRefsExist } from "./ref-check.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  paginationQuery,
  escapeIlike,
  zv,
} from "./utils.js";
import {
  SyncEntitySchema as SharedSyncEntitySchema,
  SyncEntitiesBatchSchema,
} from "../api-types.js";
import { upsertThingsInTx } from "./thing-sync.js";
import { buildSearchCondition, parseSort } from "./query-helpers.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

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
});

// ---- Helpers ----

function formatEntity(e: typeof entities.$inferSelect) {
  return {
    id: e.id,
    numericId: e.numericId,
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

  .get("/search", async (c) => {
    const parsed = SearchQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { q, limit } = parsed.data;
    const db = getDrizzleDb();
    const pattern = `%${escapeIlike(q)}%`;

    const rows = await db
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

    if (q) {
      const searchCond = buildSearchCondition(
        [entities.title, entities.id, entities.description],
        q,
      );
      if (searchCond) conditions.push(searchCond);
    }

    const where = conditions.length === 1 ? conditions[0] : and(...conditions)!;

    // Subquery for latest fact value by factId
    const latestFact = (factId: string) => sql`(
      SELECT f.numeric
      FROM facts f
      WHERE f.entity_id = ${entities.stableId}
        AND f.fact_id = ${factId}
        AND f.numeric IS NOT NULL
      ORDER BY f.as_of DESC NULLS LAST, f.id DESC
      LIMIT 1
    )`;

    const latestFactAsOf = (factId: string) => sql`(
      SELECT f.as_of
      FROM facts f
      WHERE f.entity_id = ${entities.stableId}
        AND f.fact_id = ${factId}
        AND f.numeric IS NOT NULL
      ORDER BY f.as_of DESC NULLS LAST, f.id DESC
      LIMIT 1
    )`;

    const latestFactText = (factId: string) => sql`(
      SELECT COALESCE(f.value, CAST(f.numeric AS TEXT))
      FROM facts f
      WHERE f.entity_id = ${entities.stableId}
        AND f.fact_id = ${factId}
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

    // Filtered count
    const [{ total }] = await db
      .select({ total: count() })
      .from(entities)
      .where(where);

    // Data query with lateral fact subqueries
    interface OrgRow {
      id: string;
      numericId: string | null;
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

    const rows: OrgRow[] = await db
      .select({
        id: entities.id,
        numericId: entities.numericId,
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
      .orderBy(orderClause, entities.id)
      .limit(limit)
      .offset(offset);

    return c.json({
      organizations: rows.map((r) => ({
        id: r.id,
        numericId: r.numericId,
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
    });
  })

  // ---- GET /directory?entityType=organization&measures=revenue,headcount ----
  // Returns all entities of a type with their latest facts for directory pages.
  .get("/directory", zv("query", DirectoryQuery), async (c) => {
    const { entityType, measures } = c.req.valid("query");
    const db = getDrizzleDb();

    // 1. Get all entities of the requested type
    const entityRows = await db
      .select()
      .from(entities)
      .where(eq(entities.entityType, entityType))
      .orderBy(asc(entities.title));

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
          WHERE f.entity_id = ANY(${stableIds})
            AND f.measure = ANY(${measureList})
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

    // Personnel counts: person_id → count (career history entries)
    const personnelCountMap = new Map<string, number>();
    if (stableIds.length > 0) {
      type PersonnelCountRow = { personId: string; cnt: number };
      const personnelCounts = await db.execute<PersonnelCountRow>(sql`
        SELECT person_id AS "personId", COUNT(*)::int AS cnt
        FROM personnel
        WHERE person_id = ANY(${stableIds})
          AND role_type = 'career'
        GROUP BY person_id
      `);
      for (const r of personnelCounts) {
        personnelCountMap.set(r.personId, r.cnt);
      }
    }

    // Grant counts: organization_id → grantsGiven, grantee_id → grantsReceived
    const grantsGivenMap = new Map<string, number>();
    const grantsReceivedMap = new Map<string, number>();
    if (stableIds.length > 0) {
      type GrantCountRow = { entityId: string; cnt: number };
      const grantsGiven = await db.execute<GrantCountRow>(sql`
        SELECT organization_id AS "entityId", COUNT(*)::int AS cnt
        FROM grants
        WHERE organization_id = ANY(${stableIds})
        GROUP BY organization_id
      `);
      for (const r of grantsGiven) {
        grantsGivenMap.set(r.entityId, r.cnt);
      }

      const grantsReceived = await db.execute<GrantCountRow>(sql`
        SELECT grantee_id AS "entityId", COUNT(*)::int AS cnt
        FROM grants
        WHERE grantee_id = ANY(${stableIds})
        GROUP BY grantee_id
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
        numericId: e.numericId,
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

    // Look up by slug, numeric ID, or stable ID
    const rows = await db
      .select()
      .from(entities)
      .where(or(eq(entities.id, id), eq(entities.numericId, id), eq(entities.stableId, id)));

    if (rows.length === 0) {
      return notFoundError(c, `No entity found for id: ${id}`);
    }

    return c.json(formatEntity(rows[0]));
  })

  // ---- GET / (paginated listing) ----

  .get("/", async (c) => {
    const parsed = PaginationQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { limit, offset, entityType } = parsed.data;
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
        numericId: entities.numericId,
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

  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { entities: items } = parsed.data;
    const db = getDrizzleDb();

    // Validate relatedEntries references: check that referenced entity IDs exist
    // (excluding IDs being created in this same batch, which are valid self-refs)
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
        return validationError(
          c,
          `Referenced entities not found in relatedEntries: ${missing.join(", ")}`
        );
      }
    }

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((e) => ({
        id: e.id,
        numericId: e.numericId ?? null,
        stableId: e.stableId ?? null,
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
        metadata: e.metadata ?? null,
      }));

      await tx
        .insert(entities)
        .values(allVals)
        .onConflictDoUpdate({
          target: entities.id,
          set: {
            numericId: sql`excluded.numeric_id`,
            // Use incoming stableId when provided; fall back to existing.
            stableId: sql`COALESCE(excluded.stable_id, "entities"."stable_id")`,
            entityType: sql`excluded.entity_type`,
            title: sql`excluded.title`,
            description: sql`excluded.description`,
            website: sql`excluded.website`,
            tags: sql`excluded.tags`,
            clusters: sql`excluded.clusters`,
            status: sql`excluded.status`,
            lastUpdated: sql`excluded.last_updated`,
            customFields: sql`excluded.custom_fields`,
            relatedEntries: sql`excluded.related_entries`,
            sources: sql`excluded.sources`,
            metadata: sql`excluded.metadata`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });

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
          numericId: e.numericId,
          sourceUrl: e.website,
        }))
      );

      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

export const entitiesRoute = entitiesApp;
export type EntitiesRoute = typeof entitiesApp;
