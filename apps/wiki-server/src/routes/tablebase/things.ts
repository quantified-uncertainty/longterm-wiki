import { Hono } from "hono";
import { z } from "zod";
import {
  eq,
  and,
  count,
  desc,
  asc,
  sql,
  ilike,
  or,
  isNotNull,
} from "drizzle-orm";
import { getDrizzleDb, getDb } from "../../db.js";
import { things, sourceCheckVerdicts, VALID_THING_TYPES } from "../../schema.js";
import { thingHref } from "../shared/thing-sync.js";
import {
  zv,
  validationError,
  parseJsonBody,
  invalidJsonError,
  escapeIlike,
  clampedLimit,
} from "../shared/utils.js";
import {
  normalizeSearchQuery,
  buildPrefixTsquery,
  TRIGRAM_SIMILARITY_THRESHOLD,
  TRIGRAM_FALLBACK_THRESHOLD,
} from "../../search-utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 1000;
const MAX_SYNC_BATCH = 200;

// ---- Query schemas ----

const ListQuery = z.object({
  thing_type: z.string().max(50).optional(),
  entity_type: z.string().max(100).optional(),
  parent_id: z.string().max(100).optional(),
  source_table: z.string().max(100).optional(),
  sort: z.enum(["title", "updated_at", "created_at", "thing_type"]).default("title"),
  order: z.enum(["asc", "desc"]).default("asc"),
  limit: clampedLimit(MAX_PAGE_SIZE, 50),
  offset: z.coerce.number().int().min(0).default(0),
});

const SearchQuery = z.object({
  q: z.string().min(1).max(500),
  thing_type: z.string().max(50).optional(),
  source_table: z.string().max(100).optional(),
  limit: clampedLimit(100, 20),
  offset: z.coerce.number().int().min(0).default(0),
});

const StatsQuery = z.object({
  parent_id: z.string().max(100).optional(),
});

// Verification schemas removed — verification now lives in the unified
// /api/verifications route. See discussion #2950.

// ---- Raw SQL row types ----

/** Row shape returned by the trigram search fallback query. */
interface ThingSearchRow {
  id: string;
  thing_type: string;
  title: string;
  parent_thing_id: string | null;
  source_table: string;
  source_id: string;
  entity_type: string | null;
  description: string | null;
  source_url: string | null;
  wiki_id: string | null;
  parent_title: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  similarity: number;
  verdict: string | null;
}

// ---- Helpers ----

/** Verdict select fields for the joined query. */
const verdictFields = {
  verdict: sourceCheckVerdicts.verdict,
};

/**
 * Explicit mapping from things.sourceTable (PG table names) to
 * source_check_verdicts.recordType (semantic names).
 *
 * Only tables that support source-check verdicts are included.
 * Unmapped tables will get NULL verdicts (graceful degradation).
 */
const SOURCE_TABLE_TO_RECORD_TYPE: Record<string, string> = {
  facts: "fact",
  grants: "grant",
  personnel: "personnel",
  divisions: "division",
  funding_programs: "funding-program",
  investments: "investment",
  funding_rounds: "funding-round",
  publications: "publication",
  wiki_pages: "wiki-page",
  equity_positions: "equity-position",
  policy_stakeholders: "policy-stakeholder",
  benchmark_results: "benchmark-result",
};

/**
 * SQL CASE expression mapping things.sourceTable to verdict recordType.
 * Used in the LEFT JOIN condition for source_check_verdicts.
 */
const sourceTableCaseExpr = sql.join([
  sql`CASE ${things.sourceTable}`,
  ...Object.entries(SOURCE_TABLE_TO_RECORD_TYPE).map(
    ([table, recordType]) => sql` WHEN ${table} THEN ${recordType}`
  ),
  sql` ELSE NULL END`,
]);

/** Build a raw SQL CASE expression for use in raw queries (trigram fallback). */
function buildRecordTypeCaseSql(): string {
  const whenClauses = Object.entries(SOURCE_TABLE_TO_RECORD_TYPE)
    .map(([table, recordType]) => `WHEN '${table}' THEN '${recordType}'`)
    .join(" ");
  return `CASE t.source_table ${whenClauses} ELSE NULL END`;
}

const verdictJoinOnThings = and(
  sql`${sourceCheckVerdicts.recordType} = ${sourceTableCaseExpr}`,
  eq(sourceCheckVerdicts.recordId, things.sourceId),
  sql`${sourceCheckVerdicts.fieldName} IS NULL`,
);

function formatThing(
  t: typeof things.$inferSelect,
  v?: { verdict: string | null },
) {
  return {
    id: t.id,
    thingType: t.thingType,
    title: t.title,
    parentThingId: t.parentThingId,
    sourceTable: t.sourceTable,
    sourceId: t.sourceId,
    entityType: t.entityType,
    description: t.description,
    sourceUrl: t.sourceUrl,
    wikiId: t.wikiId,
    href: thingHref(t),
    parentTitle: t.parentTitle,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    syncedAt: t.syncedAt,
    verdict: v?.verdict ?? null,
  };
}

// formatVerification and formatVerdict removed — verification now lives in
// the unified /api/verifications route. See discussion #2950.

const sortColumns = {
  title: things.title,
  updated_at: things.updatedAt,
  created_at: things.createdAt,
  thing_type: things.thingType,
} as const;

// ---- Route definition (method-chained for Hono RPC type inference) ----

const thingsApp = new Hono()

  // ---- GET /search?q=...&thing_type=...&limit=20 ----
  .get("/search", zv("query", SearchQuery), async (c) => {
    const { q: rawQ, thing_type, source_table, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    // Normalize: insert spaces at letter/digit boundaries ("sb1047" → "sb 1047")
    const q = normalizeSearchQuery(rawQ);

    const conditions = [];

    // Use full-text search with prefix matching (anth → anth:* matches Anthropic)
    const prefixQuery = buildPrefixTsquery(q);
    if (prefixQuery) {
      conditions.push(
        sql`${things}.search_vector @@ to_tsquery('english', ${prefixQuery})`
      );
    } else {
      conditions.push(
        sql`${things}.search_vector @@ plainto_tsquery('english', ${q})`
      );
    }

    if (thing_type) {
      conditions.push(eq(things.thingType, thing_type));
    }
    if (source_table) {
      conditions.push(eq(things.sourceTable, source_table));
    }

    const ftsWhere = and(...conditions);

    const rows = await db
      .select({ thing: things, ...verdictFields })
      .from(things)
      .leftJoin(sourceCheckVerdicts, verdictJoinOnThings)
      .where(ftsWhere)
      .orderBy(
        prefixQuery
          ? sql`ts_rank(${things}.search_vector, to_tsquery('english', ${prefixQuery})) DESC`
          : sql`ts_rank(${things}.search_vector, plainto_tsquery('english', ${q})) DESC`
      )
      .limit(limit)
      .offset(offset);

    // Phase 2: ILIKE fallback if FTS returned nothing
    if (rows.length === 0) {
      const pattern = `%${escapeIlike(q)}%`;
      const ilikeConditions = [
        or(
          ilike(things.title, pattern),
          ilike(things.id, pattern),
          ilike(things.description, pattern)
        ),
      ];
      if (thing_type) {
        ilikeConditions.push(eq(things.thingType, thing_type));
      }
      if (source_table) {
        ilikeConditions.push(eq(things.sourceTable, source_table));
      }

      const ilikeWhere = and(...ilikeConditions);

      const fallbackRows = await db
        .select({ thing: things, ...verdictFields })
        .from(things)
        .leftJoin(sourceCheckVerdicts, verdictJoinOnThings)
        .where(ilikeWhere)
        .orderBy(things.title)
        .limit(limit)
        .offset(offset);

      if (fallbackRows.length > 0) {
        const countResult = await db
          .select({ count: count() })
          .from(things)
          .where(ilikeWhere);

        return c.json({
          results: fallbackRows.map((r) => formatThing(r.thing, r)),
          query: q,
          total: countResult[0].count,
          searchMethod: "ilike" as const,
        });
      }
    }

    // Phase 3: Trigram similarity fallback for typo tolerance
    // (e.g. "Antrhopic" -> "Anthropic"). Only triggered when FTS + ILIKE
    // returned few results and query is >= 2 chars (short queries produce
    // too many low-quality trigram matches).
    if (rows.length < TRIGRAM_FALLBACK_THRESHOLD && q.trim().length >= 2) {
      const rawDb = getDb();
      const existingIds = rows.map((r) => r.thing.id);
      const extraFilters: string[] = [];
      const params: (string | number | string[])[] = [
        q,
        limit - rows.length,
        existingIds.length > 0 ? existingIds : ["__none__"],
      ];
      if (thing_type) {
        params.push(thing_type);
        extraFilters.push(`AND t.thing_type = $${params.length}`);
      }
      if (source_table) {
        params.push(source_table);
        extraFilters.push(`AND t.source_table = $${params.length}`);
      }
      const extraFilterSql = extraFilters.join(" ");

      const trigramRows = await rawDb.unsafe<ThingSearchRow[]>(
        `SELECT
          t.id, t.thing_type, t.title, t.parent_thing_id, t.source_table, t.source_id,
          t.entity_type, t.description, t.source_url, t.wiki_id, t.parent_title,
          t.created_at, t.updated_at, t.synced_at,
          similarity(t.title, $1) AS similarity,
          scv.verdict
        FROM things t
        LEFT JOIN source_check_verdicts scv
          ON scv.record_type = ${buildRecordTypeCaseSql()}
          AND scv.record_id = t.source_id
          AND scv.field_name IS NULL
        WHERE similarity(t.title, $1) > ${TRIGRAM_SIMILARITY_THRESHOLD}
          AND t.id NOT IN (SELECT unnest($3::text[]))
          ${extraFilterSql}
        ORDER BY similarity(t.title, $1) DESC
        LIMIT $2`,
        params,
      );

      if (trigramRows.length > 0) {
        // Convert raw SQL rows to the same shape as Drizzle results
        const trigramFormatted = trigramRows.map((r) => ({
          id: r.id,
          thingType: r.thing_type,
          title: r.title,
          parentThingId: r.parent_thing_id,
          sourceTable: r.source_table,
          sourceId: r.source_id,
          entityType: r.entity_type,
          description: r.description,
          sourceUrl: r.source_url,
          wikiId: r.wiki_id,
          href: thingHref({
            thingType: r.thing_type,
            sourceTable: r.source_table,
            sourceId: r.source_id,
            wikiId: r.wiki_id,
            entityType: r.entity_type,
          }),
          parentTitle: r.parent_title,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          syncedAt: r.synced_at,
          verdict: r.verdict ?? null,
        }));

        const combined = [
          ...rows.map((r) => formatThing(r.thing, r)),
          ...trigramFormatted,
        ];

        // Count FTS matches for a more accurate total; trigram matches are
        // supplementary so their count is not separately queried.
        const ftsCountResult = await db
          .select({ count: count() })
          .from(things)
          .where(ftsWhere);
        const ftsTotal = ftsCountResult[0].count;

        return c.json({
          results: combined,
          query: q,
          total: ftsTotal,
          searchMethod: rows.length > 0 ? ("fts+trigram" as const) : ("trigram" as const),
        });
      }
    }

    // Count total FTS matches (may exceed the returned page)
    const ftsCountResult = await db
      .select({ count: count() })
      .from(things)
      .where(ftsWhere);

    return c.json({
      results: rows.map((r) => formatThing(r.thing, r)),
      query: q,
      total: rows.length > 0 ? ftsCountResult[0].count : 0,
      searchMethod: rows.length > 0 ? ("fts" as const) : ("none" as const),
    });
  })

  // ---- GET /stats ----
  .get("/stats", zv("query", StatsQuery), async (c) => {
    const { parent_id } = c.req.valid("query");
    const db = getDrizzleDb();

    const baseCondition = parent_id
      ? eq(things.parentThingId, parent_id)
      : undefined;

    const totalResult = await db
      .select({ count: count() })
      .from(things)
      .where(baseCondition);
    const total = totalResult[0].count;

    const byTypeRows = await db
      .select({
        thingType: things.thingType,
        count: count(),
      })
      .from(things)
      .where(baseCondition)
      .groupBy(things.thingType)
      .orderBy(sql`count(*) DESC`);

    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      byType[row.thingType] = row.count;
    }

    // Count things with entity_type breakdown (entities only)
    const byEntityTypeRows = await db
      .select({
        entityType: things.entityType,
        count: count(),
      })
      .from(things)
      .where(
        baseCondition
          ? and(baseCondition, isNotNull(things.entityType))
          : isNotNull(things.entityType)
      )
      .groupBy(things.entityType)
      .orderBy(sql`count(*) DESC`);

    const byEntityType: Record<string, number> = {};
    for (const row of byEntityTypeRows) {
      if (row.entityType) byEntityType[row.entityType] = row.count;
    }

    const bySourceTableRows = await db
      .select({
        sourceTable: things.sourceTable,
        count: count(),
      })
      .from(things)
      .where(baseCondition)
      .groupBy(things.sourceTable)
      .orderBy(sql`count(*) DESC`);

    const bySourceTable: Record<string, number> = {};
    for (const row of bySourceTableRows) {
      bySourceTable[row.sourceTable] = row.count;
    }

    return c.json({
      total,
      byType,
      byEntityType,
      bySourceTable,
    });
  })

  // ---- GET /children/:parentId ----
  .get("/children/:parentId", zv("query", ListQuery), async (c) => {
    const parentId = c.req.param("parentId");
    const { thing_type, sort, order, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [eq(things.parentThingId, parentId)];
    if (thing_type) conditions.push(eq(things.thingType, thing_type));

    const whereClause = and(...conditions);

    const sortCol = sortColumns[sort];
    const orderFn = order === "desc" ? desc(sortCol) : asc(sortCol);

    const rows = await db
      .select({ thing: things, ...verdictFields })
      .from(things)
      .leftJoin(sourceCheckVerdicts, verdictJoinOnThings)
      .where(whereClause)
      .orderBy(orderFn)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(things)
      .where(whereClause);

    return c.json({
      things: rows.map((r) => formatThing(r.thing, r)),
      total: countResult[0].count,
      parentId,
    });
  })

  // Verification endpoints (GET/POST /verifications, GET/POST /verdicts) removed.
  // Verification now lives in the unified /api/verifications route.
  // See discussion #2950.

  // ---- GET /:id ----
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    // Look up by thing ID only (primary key) — sourceId lookup was
    // nondeterministic since multiple things can share the same sourceId
    // across different sourceTables.
    const rows = await db
      .select({ thing: things, ...verdictFields })
      .from(things)
      .leftJoin(sourceCheckVerdicts, verdictJoinOnThings)
      .where(eq(things.id, id))
      .limit(1);

    if (rows.length === 0) {
      return c.json(
        { error: "not_found", message: `Thing not found: ${id}` },
        404
      );
    }

    const row = rows[0];

    // Also fetch children count
    const childrenResult = await db
      .select({ count: count() })
      .from(things)
      .where(eq(things.parentThingId, row.thing.id));

    // Fetch children summary by type
    const childTypeRows = await db
      .select({
        thingType: things.thingType,
        count: count(),
      })
      .from(things)
      .where(eq(things.parentThingId, row.thing.id))
      .groupBy(things.thingType);

    const childrenByType: Record<string, number> = {};
    for (const row of childTypeRows) {
      childrenByType[row.thingType] = row.count;
    }

    return c.json({
      ...formatThing(row.thing, row),
      childrenCount: childrenResult[0].count,
      childrenByType,
    });
  })

  // ---- GET / (paginated listing) ----
  .get("/", zv("query", ListQuery), async (c) => {
    const {
      thing_type,
      entity_type,
      parent_id,
      source_table,
      sort,
      order,
      limit,
      offset,
    } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (thing_type) conditions.push(eq(things.thingType, thing_type));
    if (entity_type) conditions.push(eq(things.entityType, entity_type));
    if (parent_id) conditions.push(eq(things.parentThingId, parent_id));
    if (source_table) conditions.push(eq(things.sourceTable, source_table));

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const sortCol = sortColumns[sort];
    const orderFn = order === "desc" ? desc(sortCol) : asc(sortCol);

    const rows = await db
      .select({ thing: things, ...verdictFields })
      .from(things)
      .leftJoin(sourceCheckVerdicts, verdictJoinOnThings)
      .where(whereClause)
      .orderBy(orderFn)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(things)
      .where(whereClause);

    return c.json({
      things: rows.map((r) => formatThing(r.thing, r)),
      total: countResult[0].count,
      limit,
      offset,
    });
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const SyncThingSchema = z.object({
      id: z.string().min(1).max(200),
      thingType: z.enum(VALID_THING_TYPES),
      title: z.string().min(1).max(2000),
      parentThingId: z.string().max(200).optional(),
      sourceTable: z.string().min(1).max(100),
      sourceId: z.string().min(1).max(200),
      entityType: z.string().max(100).optional(),
      description: z.string().max(10000).optional(),
      sourceUrl: z.string().max(2048).optional(),
      wikiId: z.string().max(20).optional(),
      parentTitle: z.string().max(500).optional(),
    });

    const SyncBatchSchema = z.object({
      things: z.array(SyncThingSchema).min(1).max(MAX_SYNC_BATCH),
    });

    const parsed = SyncBatchSchema.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const items = parsed.data.things;

    // Reject duplicate (sourceTable, sourceId) within the batch — duplicates
    // would cause the multi-row upsert to fail and roll back.
    const seenSourceKeys = new Set<string>();
    for (const item of items) {
      const key = `${item.sourceTable}\0${item.sourceId}`;
      if (seenSourceKeys.has(key)) {
        return validationError(
          c,
          `Duplicate source key in batch: (${item.sourceTable}, ${item.sourceId})`
        );
      }
      seenSourceKeys.add(key);
    }

    const db = getDrizzleDb();
    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
        id: item.id,
        thingType: item.thingType,
        title: item.title,
        parentThingId: item.parentThingId ?? null,
        sourceTable: item.sourceTable,
        sourceId: item.sourceId,
        entityType: item.entityType ?? null,
        description: item.description ?? null,
        sourceUrl: item.sourceUrl ?? null,
        wikiId: item.wikiId ?? null,
      }));

      await tx
        .insert(things)
        .values(allVals)
        .onConflictDoUpdate({
          target: [things.sourceTable, things.sourceId],
          set: {
            // Do NOT update `id` — it's the PK and may be referenced
            // by external systems. Changing it would break links.
            thingType: sql`excluded.thing_type`,
            title: sql`excluded.title`,
            parentThingId: sql`excluded.parent_thing_id`,
            entityType: sql`excluded.entity_type`,
            description: sql`excluded.description`,
            sourceUrl: sql`excluded.source_url`,
            wikiId: sql`excluded.wiki_id`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const thingsRoute = thingsApp;
export type ThingsRoute = typeof thingsApp;
