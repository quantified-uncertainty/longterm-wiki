/**
 * Statements route — Hono RPC method-chained route for the Statements system.
 *
 * - GET /          — list with filters (by entity, property, variety, status)
 * - GET /current   — current value for entity+property (valid_end IS NULL)
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
  properties,
} from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
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
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ---- Body schemas ----

const PatchStatementBody = z.object({
  status: z.enum(["active", "superseded", "retracted"]).optional(),
  archiveReason: z.string().max(2000).nullish(),
  verdict: z.string().max(50).nullish(),
  verdictScore: z.number().min(0).max(1).nullish(),
  verdictQuotes: z.string().max(10000).nullish(),
  verdictModel: z.string().max(200).nullish(),
  note: z.string().max(2000).nullish(),
});

const CreateStatementBody = z.object({
  variety: z.enum(["structured", "attributed"]),
  statementText: z.string().max(2000).nullish(),
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
    const { entityId } = c.req.valid("query");
    const db = getDrizzleDb();

    // Fetch statements, citations, and properties in parallel
    const [rows, allCitations, propertyRows] = await Promise.all([
      db
        .select()
        .from(statements)
        .where(eq(statements.subjectEntityId, entityId))
        .orderBy(desc(statements.validStart)),
      db
        .select()
        .from(statementCitations)
        .where(
          sql`${statementCitations.statementId} IN (
            SELECT ${statements.id} FROM ${statements}
            WHERE ${statements.subjectEntityId} = ${entityId}
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

  // ---- POST / — create statement + optional citations ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = CreateStatementBody.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const data = parsed.data;
    const db = getDrizzleDb();

    // Wrap in transaction for atomicity (statement + citations)
    const statementId = await db.transaction(async (tx) => {
      const result = await tx
        .insert(statements)
        .values({
          variety: data.variety,
          statementText: data.statementText ?? null,
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
          status: "active",
        })
        .returning({ id: statements.id });

      if (result.length === 0) {
        throw new Error("Statement insert returned no rows");
      }

      const id = result[0].id;

      // Insert citations if provided
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

      return id;
    });

    return c.json({ id: statementId, ok: true }, 201);
  });

export const statementsRoute = statementsApp;
export type StatementsRoute = typeof statementsApp;
