/**
 * Statements route — Hono RPC method-chained route for the Statements system.
 *
 * - GET /          — list with filters (by entity, property, variety, status)
 * - GET /current   — current value for entity+property (valid_end IS NULL)
 * - GET /by-page   — all statements for a page with citations and footnote links
 * - GET /by-page/summary — per-footnote verification summary for citation dots
 * - GET /properties — list all properties with statement counts
 * - GET /stats     — basic statistics
 * - PATCH /:id     — update statement status, verdict, or note
 * - POST /         — create statement + optional citations
 */

import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import {
  eq,
  and,
  count,
  desc,
  isNull,
  sql,
} from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import {
  statements,
  statementCitations,
  statementPageReferences,
  properties,
  entityCoverageScores,
} from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  VALIDATION_ERROR,
} from "./utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 500;

// ---- Query schemas ----

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  entityId: z.string().max(200).optional(),
  propertyId: z.string().max(200).optional(),
  variety: z.enum(["structured", "attributed"]).optional(),
  status: z.enum(["active", "superseded", "retracted"]).optional(),
});

const CurrentQuery = z.object({
  entityId: z.string().min(1).max(200),
  propertyId: z.string().min(1).max(200),
});

const ByEntityQuery = z.object({
  entityId: z.string().min(1).max(200),
  includeRetracted: z.coerce.boolean().default(false),
});

const ByPageQuery = z.object({
  pageId: z.coerce.number().int().positive(),
});

// ---- Zod validator helper (uses Hono's built-in validator for RPC type inference) ----

function zv<T extends z.ZodType>(target: "query", schema: T) {
  return validator(target, (value, c) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      return c.json(
        { error: VALIDATION_ERROR, message: result.error.message },
        400
      );
    }
    return result.data as z.infer<T>;
  });
}

// ---- Helpers ----

function formatStatement(s: typeof statements.$inferSelect) {
  return {
    id: s.id,
    variety: s.variety,
    statementText: s.statementText,
    status: s.status,
    archiveReason: s.archiveReason,
    subjectEntityId: s.subjectEntityId,
    propertyId: s.propertyId,
    qualifierKey: s.qualifierKey,
    valueNumeric: s.valueNumeric,
    valueUnit: s.valueUnit,
    valueText: s.valueText,
    valueEntityId: s.valueEntityId,
    valueDate: s.valueDate,
    valueSeries: s.valueSeries,
    validStart: s.validStart,
    validEnd: s.validEnd,
    temporalGranularity: s.temporalGranularity,
    attributedTo: s.attributedTo,
    verdict: s.verdict,
    verdictScore: s.verdictScore,
    verdictQuotes: s.verdictQuotes,
    verdictModel: s.verdictModel,
    verifiedAt: s.verifiedAt,
    claimCategory: s.claimCategory,
    sourceFactKey: s.sourceFactKey,
    note: s.note,
    qualityScore: s.qualityScore,
    qualityDimensions: s.qualityDimensions,
    scoredAt: s.scoredAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ---- Body schemas ----

const BatchScoreBody = z.object({
  scores: z.array(z.object({
    statementId: z.number().int().positive(),
    qualityScore: z.number().min(0).max(1),
    qualityDimensions: z.record(z.number()),
  })).min(1).max(500),
});

const CoverageScoreBody = z.object({
  entityId: z.string().min(1).max(200),
  coverageScore: z.number().min(0).max(1),
  categoryScores: z.record(z.number()),
  statementCount: z.number().int().min(0),
  qualityAvg: z.number().min(0).max(1).nullish(),
});

const CoverageScoreQuery = z.object({
  entityId: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const PatchStatementBody = z.object({
  status: z.enum(["active", "superseded", "retracted"]).optional(),
  variety: z.enum(["structured", "attributed"]).optional(),
  statementText: z.string().min(1).max(2000).optional(),
  validStart: z.string().max(20).nullish(),
  validEnd: z.string().max(20).nullish(),
  attributedTo: z.string().max(200).nullish(),
  archiveReason: z.string().max(2000).nullish(),
  verdict: z.string().max(50).nullish(),
  verdictScore: z.number().min(0).max(1).nullish(),
  verdictQuotes: z.string().max(10000).nullish(),
  verdictModel: z.string().max(200).nullish(),
  note: z.string().max(2000).nullish(),
});

const CreateStatementBody = z.object({
  variety: z.enum(["structured", "attributed"]),
  statementText: z.string().min(1).max(2000), // Required: every statement needs human-readable text
  subjectEntityId: z.string().min(1).max(200),
  propertyId: z.string().max(200).nullish(),
  qualifierKey: z.string().max(200).nullish(),
  valueNumeric: z.number().nullish(),
  valueUnit: z.string().max(100).nullish(),
  valueText: z.string().max(2000).nullish(),
  valueEntityId: z.string().max(200).nullish(),
  valueDate: z.string().max(20).nullish(),
  valueSeries: z.record(z.unknown()).nullish(),
  validStart: z.string().max(20).nullish(),
  validEnd: z.string().max(20).nullish(),
  temporalGranularity: z.string().max(20).nullish(),
  attributedTo: z.string().max(200).nullish(),
  note: z.string().max(2000).nullish(),
  sourceFactKey: z.string().max(200).nullish(),
  claimCategory: z.string().max(50).nullish(),
  verdict: z.string().max(50).nullish(),
  verdictScore: z.number().min(0).max(1).nullish(),
  verdictModel: z.string().max(200).nullish(),
  citations: z
    .array(
      z.object({
        resourceId: z.string().max(200).nullish(),
        url: z.string().url().max(2000).nullish(),
        sourceQuote: z.string().max(5000).nullish(),
        locationNote: z.string().max(500).nullish(),
        isPrimary: z.boolean().default(false),
      })
    )
    .optional()
    .default([]),
  pageReferences: z
    .array(
      z.object({
        pageIdInt: z.number().int().positive(),
        footnoteResourceId: z.string().max(200).nullish(),
        section: z.string().max(500).nullish(),
      })
    )
    .optional()
    .default([]),
});

const BatchCreateBody = z.object({
  statements: z.array(CreateStatementBody).min(1).max(100),
});

const ClearByEntityQuery = z.object({
  entityId: z.string().min(1).max(200),
});

// ---- Route definition (method-chained for Hono RPC type inference) ----

const statementsApp = new Hono()

  // ---- GET / — list statements with filters ----
  .get("/", zv("query", ListQuery), async (c) => {
    const { limit, offset, entityId, propertyId, variety, status } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (entityId) conditions.push(eq(statements.subjectEntityId, entityId));
    if (propertyId) conditions.push(eq(statements.propertyId, propertyId));
    if (variety) conditions.push(eq(statements.variety, variety));
    if (status) conditions.push(eq(statements.status, status));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(statements)
        .where(whereClause)
        .orderBy(desc(statements.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(statements).where(whereClause),
    ]);

    // Fetch citation counts for the returned statements
    const statementIds = rows.map((r) => r.id);
    const citationCounts =
      statementIds.length > 0
        ? await db
            .select({
              statementId: statementCitations.statementId,
              count: count(),
            })
            .from(statementCitations)
            .where(
              sql`${statementCitations.statementId} IN (${sql.join(
                statementIds.map((id) => sql`${id}`),
                sql`, `
              )})`
            )
            .groupBy(statementCitations.statementId)
        : [];

    const citCountMap = new Map(
      citationCounts.map((r) => [r.statementId, r.count])
    );

    return c.json({
      statements: rows.map((r) => ({
        ...formatStatement(r),
        citationCount: citCountMap.get(r.id) ?? 0,
      })),
      total: countResult[0].count,
      limit,
      offset,
    });
  })

  // ---- GET /current — current value for entity+property ----
  .get("/current", zv("query", CurrentQuery), async (c) => {
    const { entityId, propertyId } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(statements)
      .where(
        and(
          eq(statements.subjectEntityId, entityId),
          eq(statements.propertyId, propertyId),
          eq(statements.status, "active"),
          isNull(statements.validEnd)
        )
      )
      .orderBy(desc(statements.validStart))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ statement: null });
    }

    // Also fetch citations for this statement
    const citationRows = await db
      .select()
      .from(statementCitations)
      .where(eq(statementCitations.statementId, rows[0].id));

    return c.json({
      statement: formatStatement(rows[0]),
      citations: citationRows.map((cit) => ({
        id: cit.id,
        resourceId: cit.resourceId,
        url: cit.url,
        sourceQuote: cit.sourceQuote,
        locationNote: cit.locationNote,
        isPrimary: cit.isPrimary,
      })),
    });
  })

  // ---- GET /by-entity — all statements for an entity, with citations and property info ----
  .get("/by-entity", zv("query", ByEntityQuery), async (c) => {
    const { entityId, includeRetracted } = c.req.valid("query");
    const db = getDrizzleDb();

    // Build where clause — exclude retracted by default
    const entityConditions = [eq(statements.subjectEntityId, entityId)];
    if (!includeRetracted) {
      entityConditions.push(sql`${statements.status} != 'retracted'`);
    }
    const entityWhere = and(...entityConditions);

    // Fetch statements, citations, and properties in parallel
    const [rows, allCitations, propertyRows] = await Promise.all([
      db
        .select()
        .from(statements)
        .where(entityWhere)
        .orderBy(desc(statements.validStart)),
      db
        .select()
        .from(statementCitations)
        .where(
          sql`${statementCitations.statementId} IN (
            SELECT ${statements.id} FROM ${statements}
            WHERE ${statements.subjectEntityId} = ${entityId}
            ${includeRetracted ? sql`` : sql`AND ${statements.status} != 'retracted'`}
          )`
        ),
      db.select().from(properties),
    ]);

    // Build citation map: statementId -> citations[]
    const citationMap = new Map<number, typeof allCitations>();
    for (const cit of allCitations) {
      const list = citationMap.get(cit.statementId) ?? [];
      list.push(cit);
      citationMap.set(cit.statementId, list);
    }

    // Build property map: propertyId -> property
    const propertyMap = new Map(propertyRows.map((p) => [p.id, p]));

    // Format statements with joined citations and property info
    const formatted = rows.map((s) => {
      const prop = s.propertyId ? propertyMap.get(s.propertyId) : null;
      const cits = citationMap.get(s.id) ?? [];
      return {
        ...formatStatement(s),
        property: prop
          ? {
              id: prop.id,
              label: prop.label,
              category: prop.category,
              valueType: prop.valueType,
              unitFormatId: prop.unitFormatId,
            }
          : null,
        citations: cits.map((cit) => ({
          id: cit.id,
          resourceId: cit.resourceId,
          url: cit.url,
          sourceQuote: cit.sourceQuote,
          locationNote: cit.locationNote,
          isPrimary: cit.isPrimary,
        })),
      };
    });

    // Split by variety
    const structured = formatted.filter((s) => s.variety === "structured");
    const attributed = formatted.filter((s) => s.variety === "attributed");

    return c.json({ structured, attributed, total: rows.length });
  })

  // ---- GET /by-page — all statements for a page with citations and footnote links ----
  .get("/by-page", zv("query", ByPageQuery), async (c) => {
    const { pageId } = c.req.valid("query");
    const db = getDrizzleDb();

    // Get all page references for this page
    const refs = await db
      .select()
      .from(statementPageReferences)
      .where(eq(statementPageReferences.pageIdInt, pageId));

    if (refs.length === 0) {
      return c.json({ statements: [] });
    }

    const statementIds = [...new Set(refs.map((r) => r.statementId))];

    if (statementIds.length === 0) {
      return c.json({ statements: [] });
    }

    // Fetch statements and citations in parallel
    const [stmtRows, citRows] = await Promise.all([
      db
        .select()
        .from(statements)
        .where(
          sql`${statements.id} IN (${sql.join(
            statementIds.map((id) => sql`${id}`),
            sql`, `
          )})`
        ),
      db
        .select()
        .from(statementCitations)
        .where(
          sql`${statementCitations.statementId} IN (${sql.join(
            statementIds.map((id) => sql`${id}`),
            sql`, `
          )})`
        ),
    ]);

    // Build citation map: statementId -> citations[]
    const citationMap = new Map<number, (typeof citRows)[number][]>();
    for (const cit of citRows) {
      const list = citationMap.get(cit.statementId) ?? [];
      list.push(cit);
      citationMap.set(cit.statementId, list);
    }

    // Build statement map: id -> statement
    const stmtMap = new Map(stmtRows.map((s) => [s.id, s]));

    // Build ref map: statementId -> page reference info[] (a statement can appear multiple times on a page)
    const refMap = new Map<
      number,
      Array<{ footnoteResourceId: string | null; section: string | null }>
    >();
    for (const ref of refs) {
      if (ref.statementId !== null) {
        const list = refMap.get(ref.statementId) ?? [];
        list.push({
          footnoteResourceId: ref.footnoteResourceId,
          section: ref.section,
        });
        refMap.set(ref.statementId, list);
      }
    }

    // Combine: for each statement, attach citations and page reference info
    const result = statementIds
      .map((id) => {
        const stmt = stmtMap.get(id);
        if (!stmt) return null;
        const cits = citationMap.get(id) ?? [];
        const pageRefs = refMap.get(id) ?? [];
        return {
          ...formatStatement(stmt),
          pageReferences: pageRefs,
          citations: cits.map((cit) => ({
            id: cit.id,
            resourceId: cit.resourceId,
            url: cit.url,
            sourceQuote: cit.sourceQuote,
            locationNote: cit.locationNote,
            isPrimary: cit.isPrimary,
          })),
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    return c.json({ statements: result });
  })

  // ---- GET /by-page/summary — per-footnote verification summary for citation dots ----
  .get("/by-page/summary", zv("query", ByPageQuery), async (c) => {
    const { pageId } = c.req.valid("query");
    const db = getDrizzleDb();

    // Get all page references for this page, joined with statement verdicts
    const rows = await db
      .select({
        footnoteResourceId: statementPageReferences.footnoteResourceId,
        verdict: statements.verdict,
      })
      .from(statementPageReferences)
      .innerJoin(
        statements,
        eq(statementPageReferences.statementId, statements.id)
      )
      .where(eq(statementPageReferences.pageIdInt, pageId));

    // Group by footnoteResourceId and aggregate verdicts
    const footnoteMap = new Map<
      string,
      {
        statementCount: number;
        verdicts: { verified: number; disputed: number; unchecked: number };
      }
    >();

    for (const row of rows) {
      const key = row.footnoteResourceId ?? "__none__";
      const entry = footnoteMap.get(key) ?? {
        statementCount: 0,
        verdicts: { verified: 0, disputed: 0, unchecked: 0 },
      };
      entry.statementCount++;
      if (row.verdict === "verified") {
        entry.verdicts.verified++;
      } else if (
        row.verdict === "disputed" ||
        row.verdict === "unsupported"
      ) {
        entry.verdicts.disputed++;
      } else {
        entry.verdicts.unchecked++;
      }
      footnoteMap.set(key, entry);
    }

    const footnotes = [...footnoteMap.entries()].map(([key, val]) => ({
      footnoteResourceId: key === "__none__" ? null : key,
      statementCount: val.statementCount,
      verdicts: val.verdicts,
    }));

    return c.json({ footnotes });
  })

  // ---- GET /properties — list all properties with statement counts ----
  .get("/properties", async (c) => {
    const db = getDrizzleDb();

    // Fetch all properties and count statements per property in parallel
    const [propertyRows, stmtCounts] = await Promise.all([
      db.select().from(properties),
      db
        .select({
          propertyId: statements.propertyId,
          count: count(),
        })
        .from(statements)
        .where(eq(statements.status, "active"))
        .groupBy(statements.propertyId),
    ]);

    const countMap = new Map(
      stmtCounts
        .filter((r) => r.propertyId !== null)
        .map((r) => [r.propertyId!, r.count])
    );

    return c.json({
      properties: propertyRows.map((p) => ({
        id: p.id,
        label: p.label,
        category: p.category,
        description: p.description,
        entityTypes: p.entityTypes,
        valueType: p.valueType,
        defaultUnit: p.defaultUnit,
        stalenessCadence: p.stalenessCadence,
        unitFormatId: p.unitFormatId,
        statementCount: countMap.get(p.id) ?? 0,
      })),
    });
  })

  // ---- GET /stats — basic statistics ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [totalResult, byVariety, byStatus] = await Promise.all([
      db.select({ count: count() }).from(statements),
      db
        .select({
          variety: statements.variety,
          count: count(),
        })
        .from(statements)
        .groupBy(statements.variety),
      db
        .select({
          status: statements.status,
          count: count(),
        })
        .from(statements)
        .groupBy(statements.status),
    ]);

    const propertiesCount = await db.select({ count: count() }).from(properties);

    return c.json({
      total: totalResult[0].count,
      byVariety: Object.fromEntries(byVariety.map((r) => [r.variety, r.count])),
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
      propertiesCount: propertiesCount[0].count,
    });
  })

  // ---- GET /:id — fetch a single statement with citations and property ----
  .get("/:id", async (c) => {
    const idParam = c.req.param("id");
    const id = parseInt(idParam, 10);
    if (isNaN(id) || id <= 0) {
      return c.json(
        { error: VALIDATION_ERROR, message: "Statement ID must be a positive integer" },
        400
      );
    }

    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(statements)
      .where(eq(statements.id, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Statement not found: ${id}`);
    }

    const stmt = rows[0];

    // Fetch citations and property in parallel
    const [citationRows, propertyRows] = await Promise.all([
      db
        .select()
        .from(statementCitations)
        .where(eq(statementCitations.statementId, id)),
      stmt.propertyId
        ? db
            .select()
            .from(properties)
            .where(eq(properties.id, stmt.propertyId))
            .limit(1)
        : Promise.resolve([]),
    ]);

    const prop = propertyRows[0] ?? null;

    return c.json({
      statement: {
        ...formatStatement(stmt),
        citationCount: citationRows.length,
      },
      citations: citationRows.map((cit) => ({
        id: cit.id,
        resourceId: cit.resourceId,
        url: cit.url,
        sourceQuote: cit.sourceQuote,
        locationNote: cit.locationNote,
        isPrimary: cit.isPrimary,
      })),
      property: prop
        ? {
            id: prop.id,
            label: prop.label,
            category: prop.category,
            description: prop.description,
            valueType: prop.valueType,
            unitFormatId: prop.unitFormatId,
          }
        : null,
    });
  })

  // ---- PATCH /:id — update statement status, verdict, or note ----
  .patch("/:id", async (c) => {
    const idParam = c.req.param("id");
    const id = parseInt(idParam, 10);
    if (isNaN(id)) {
      return c.json({ error: VALIDATION_ERROR, message: "Invalid statement ID" }, 400);
    }

    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = PatchStatementBody.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const data = parsed.data;
    const db = getDrizzleDb();

    // Build update set — inline to match codebase pattern (sql`now()` accepted at runtime)
    const rows = await db
      .update(statements)
      .set({
        ...(data.status !== undefined && { status: data.status }),
        ...(data.variety !== undefined && { variety: data.variety }),
        ...(data.statementText !== undefined && { statementText: data.statementText }),
        ...(data.validStart !== undefined && { validStart: data.validStart ?? null }),
        ...(data.validEnd !== undefined && { validEnd: data.validEnd ?? null }),
        ...(data.attributedTo !== undefined && { attributedTo: data.attributedTo ?? null }),
        ...(data.archiveReason !== undefined && { archiveReason: data.archiveReason ?? null }),
        ...(data.verdict !== undefined && { verdict: data.verdict ?? null }),
        ...(data.verdictScore !== undefined && { verdictScore: data.verdictScore ?? null }),
        ...(data.verdictQuotes !== undefined && { verdictQuotes: data.verdictQuotes ?? null }),
        ...(data.verdictModel !== undefined && { verdictModel: data.verdictModel ?? null }),
        ...(data.note !== undefined && { note: data.note ?? null }),
        updatedAt: sql`now()`,
      })
      .where(eq(statements.id, id))
      .returning();

    if (rows.length === 0) {
      return c.json({ error: "not_found", message: "Statement not found" }, 404);
    }

    return c.json({ statement: formatStatement(rows[0]), ok: true });
  })

  // ---- POST / — create statement + optional citations + page references ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = CreateStatementBody.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const data = parsed.data;
    const db = getDrizzleDb();

    const statementId = await db.transaction(async (tx) => {
      const result = await tx
        .insert(statements)
        .values({
          variety: data.variety,
          statementText: data.statementText,
          subjectEntityId: data.subjectEntityId,
          propertyId: data.propertyId ?? null,
          qualifierKey: data.qualifierKey ?? null,
          valueNumeric: data.valueNumeric ?? null,
          valueUnit: data.valueUnit ?? null,
          valueText: data.valueText ?? null,
          valueEntityId: data.valueEntityId ?? null,
          valueDate: data.valueDate ?? null,
          valueSeries: (data.valueSeries as Record<string, unknown>) ?? null,
          validStart: data.validStart ?? null,
          validEnd: data.validEnd ?? null,
          temporalGranularity: data.temporalGranularity ?? null,
          attributedTo: data.attributedTo ?? null,
          note: data.note ?? null,
          sourceFactKey: data.sourceFactKey ?? null,
          claimCategory: data.claimCategory ?? null,
          verdict: data.verdict ?? null,
          verdictScore: data.verdictScore ?? null,
          verdictModel: data.verdictModel ?? null,
          status: "active",
        })
        .returning({ id: statements.id });

      if (result.length === 0) {
        throw new Error("Statement insert returned no rows");
      }

      const id = result[0].id;

      if (data.citations.length > 0) {
        await tx.insert(statementCitations).values(
          data.citations.map((cit) => ({
            statementId: id,
            resourceId: cit.resourceId ?? null,
            url: cit.url ?? null,
            sourceQuote: cit.sourceQuote ?? null,
            locationNote: cit.locationNote ?? null,
            isPrimary: cit.isPrimary,
          }))
        );
      }

      if (data.pageReferences.length > 0) {
        await tx.insert(statementPageReferences).values(
          data.pageReferences.map((ref) => ({
            statementId: id,
            pageIdInt: ref.pageIdInt,
            footnoteResourceId: ref.footnoteResourceId ?? null,
            section: ref.section ?? null,
          }))
        );
      }

      return id;
    });

    return c.json({ id: statementId, ok: true }, 201);
  })

  // ---- POST /batch — bulk create statements ----
  .post("/batch", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = BatchCreateBody.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const items = parsed.data.statements;
    const db = getDrizzleDb();

    const results: Array<{ id: number; sourceFactKey: string | null }> = [];

    await db.transaction(async (tx) => {
      for (let idx = 0; idx < items.length; idx++) {
        const data = items[idx];
        const result = await tx
          .insert(statements)
          .values({
            variety: data.variety,
            statementText: data.statementText,
            subjectEntityId: data.subjectEntityId,
            propertyId: data.propertyId ?? null,
            qualifierKey: data.qualifierKey ?? null,
            valueNumeric: data.valueNumeric ?? null,
            valueUnit: data.valueUnit ?? null,
            valueText: data.valueText ?? null,
            valueEntityId: data.valueEntityId ?? null,
            valueDate: data.valueDate ?? null,
            valueSeries:
              (data.valueSeries as Record<string, unknown>) ?? null,
            validStart: data.validStart ?? null,
            validEnd: data.validEnd ?? null,
            temporalGranularity: data.temporalGranularity ?? null,
            attributedTo: data.attributedTo ?? null,
            note: data.note ?? null,
            sourceFactKey: data.sourceFactKey ?? null,
            claimCategory: data.claimCategory ?? null,
            verdict: data.verdict ?? null,
            verdictScore: data.verdictScore ?? null,
            verdictModel: data.verdictModel ?? null,
            status: "active",
          })
          .returning({ id: statements.id });

        if (result.length === 0) {
          throw new Error(`Statement insert returned no rows for item at index ${results.length}`);
        }
        const id = result[0].id;

        if (data.citations.length > 0) {
          await tx.insert(statementCitations).values(
            data.citations.map((cit) => ({
              statementId: id,
              resourceId: cit.resourceId ?? null,
              url: cit.url ?? null,
              sourceQuote: cit.sourceQuote ?? null,
              locationNote: cit.locationNote ?? null,
              isPrimary: cit.isPrimary,
            }))
          );
        }

        if (data.pageReferences.length > 0) {
          await tx.insert(statementPageReferences).values(
            data.pageReferences.map((ref) => ({
              statementId: id,
              pageIdInt: ref.pageIdInt,
              footnoteResourceId: ref.footnoteResourceId ?? null,
              section: ref.section ?? null,
            }))
          );
        }

        results.push({
          id,
          sourceFactKey: data.sourceFactKey ?? null,
        });
      }
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      // Log the full error including Postgres detail/hint/constraint
      const pgErr = err as { detail?: string; constraint?: string; code?: string; hint?: string };
      console.error(`[statements/batch] Transaction failed at item ${results.length}: ${msg}`);
      if (pgErr.detail) console.error(`  PG detail: ${pgErr.detail}`);
      if (pgErr.hint) console.error(`  PG hint: ${pgErr.hint}`);
      if (pgErr.constraint) console.error(`  PG constraint: ${pgErr.constraint}`);
      if (pgErr.code) console.error(`  PG code: ${pgErr.code}`);
      throw err;
    });

    return c.json({ inserted: results.length, results, ok: true }, 201);
  })

  // ---- POST /score — batch update quality scores ----
  .post("/score", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = BatchScoreBody.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const { scores } = parsed.data;
    const db = getDrizzleDb();

    // Bulk UPDATE using CASE/WHEN — single query instead of N+1
    const ids = scores.map((s) => s.statementId);
    const scoreCases = sql.join(
      scores.map((s) => sql`WHEN id = ${s.statementId} THEN ${s.qualityScore}`),
      sql` `,
    );
    const dimCases = sql.join(
      scores.map((s) => sql`WHEN id = ${s.statementId} THEN ${JSON.stringify(s.qualityDimensions)}::jsonb`),
      sql` `,
    );
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);

    const result = await db.execute(sql`
      UPDATE statements SET
        quality_score = CASE ${scoreCases} ELSE quality_score END,
        quality_dimensions = CASE ${dimCases} ELSE quality_dimensions END,
        scored_at = now(),
        updated_at = now()
      WHERE id IN (${idList})
    `);

    const updated = typeof result === 'object' && result !== null && 'rowCount' in result
      ? (result as { rowCount: number }).rowCount
      : scores.length;

    return c.json({ updated, ok: true });
  })

  // ---- POST /coverage-score — store entity coverage score ----
  .post("/coverage-score", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = CoverageScoreBody.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const data = parsed.data;
    const db = getDrizzleDb();

    const result = await db
      .insert(entityCoverageScores)
      .values({
        entityId: data.entityId,
        coverageScore: data.coverageScore,
        categoryScores: data.categoryScores,
        statementCount: data.statementCount,
        qualityAvg: data.qualityAvg ?? null,
      })
      .returning({ id: entityCoverageScores.id });

    return c.json({ id: result[0].id, ok: true }, 201);
  })

  // ---- GET /coverage-scores — coverage score history for an entity ----
  .get("/coverage-scores", zv("query", CoverageScoreQuery), async (c) => {
    const { entityId, limit } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(entityCoverageScores)
      .where(eq(entityCoverageScores.entityId, entityId))
      .orderBy(desc(entityCoverageScores.scoredAt))
      .limit(limit);

    return c.json({
      scores: rows.map((r) => ({
        id: r.id,
        entityId: r.entityId,
        coverageScore: r.coverageScore,
        categoryScores: r.categoryScores,
        statementCount: r.statementCount,
        qualityAvg: r.qualityAvg,
        scoredAt: r.scoredAt,
      })),
    });
  })

  // ---- POST /cleanup — delete retracted and empty statements ----
  .post("/cleanup", async (c) => {
    const body = await parseJsonBody(c);
    const parsed = z
      .object({
        entityId: z.string().max(200).optional(),
        dryRun: z.boolean().default(true),
      })
      .safeParse(body ?? {});
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { entityId, dryRun } = parsed.data;
    const db = getDrizzleDb();

    // Find retracted statements
    const retractedConditions = [eq(statements.status, "retracted")];
    if (entityId) retractedConditions.push(eq(statements.subjectEntityId, entityId));

    const retractedRows = await db
      .select({ id: statements.id, subjectEntityId: statements.subjectEntityId })
      .from(statements)
      .where(and(...retractedConditions));

    // Find empty structured statements (no property and no values)
    const emptyConditions = [
      eq(statements.variety, "structured"),
      isNull(statements.propertyId),
      isNull(statements.valueNumeric),
      isNull(statements.valueText),
      isNull(statements.valueEntityId),
      isNull(statements.valueDate),
      isNull(statements.valueSeries),
    ];
    if (entityId) emptyConditions.push(eq(statements.subjectEntityId, entityId));

    const emptyRows = await db
      .select({ id: statements.id, subjectEntityId: statements.subjectEntityId })
      .from(statements)
      .where(and(...emptyConditions));

    const allIds = [...new Set([...retractedRows.map((r) => r.id), ...emptyRows.map((r) => r.id)])];

    if (dryRun || allIds.length === 0) {
      return c.json({
        dryRun: true,
        retracted: retractedRows.length,
        empty: emptyRows.length,
        totalToDelete: allIds.length,
        ok: true,
      });
    }

    // Delete citations first (FK constraint), then statements
    console.warn(`[statements/cleanup] Deleting ${allIds.length} statements (${retractedRows.length} retracted, ${emptyRows.length} empty)`);

    await db
      .delete(statementCitations)
      .where(
        sql`${statementCitations.statementId} IN (${sql.join(
          allIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      );

    await db
      .delete(statementPageReferences)
      .where(
        sql`${statementPageReferences.statementId} IN (${sql.join(
          allIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      );

    const deleted = await db
      .delete(statements)
      .where(
        sql`${statements.id} IN (${sql.join(
          allIds.map((id) => sql`${id}`),
          sql`, `
        )})`
      )
      .returning({ id: statements.id });

    return c.json({
      dryRun: false,
      retracted: retractedRows.length,
      empty: emptyRows.length,
      deleted: deleted.length,
      ok: true,
    });
  })

  // ---- POST /clear-by-entity — delete all statements for an entity ----
  .post("/clear-by-entity", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = ClearByEntityQuery.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const { entityId } = parsed.data;
    const db = getDrizzleDb();

    const deleted = await db
      .delete(statements)
      .where(eq(statements.subjectEntityId, entityId))
      .returning({ id: statements.id });

    return c.json({ deleted: deleted.length, ok: true });
  });

export const statementsRoute = statementsApp;
export type StatementsRoute = typeof statementsApp;
