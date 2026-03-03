/**
 * Statements route — Hono RPC method-chained route for the Statements system.
 *
 * - GET /               — list with filters (by entity, property, variety, status)
 * - GET /current        — current value for entity+property (valid_end IS NULL)
 * - GET /stats          — basic statistics
 * - GET /by-entity      — all statements for an entity, grouped by property category
 * - GET /properties     — full properties list with statement counts
 * - GET /history        — all values for entity+property over time
 * - GET /:id            — single statement with full citations
 * - PATCH /:id          — update statement status, verdict, or note
 * - POST /              — create statement + optional citations
 */

import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import {
  eq,
  and,
  count,
  desc,
  asc,
  isNull,
  sql,
  inArray,
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

const MAX_PAGE_SIZE = 200;

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

const HistoryQuery = z.object({
  entityId: z.string().min(1).max(200),
  propertyId: z.string().min(1).max(200),
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

function formatCitation(cit: typeof statementCitations.$inferSelect) {
  return {
    id: cit.id,
    resourceId: cit.resourceId,
    url: cit.url,
    sourceQuote: cit.sourceQuote,
    locationNote: cit.locationNote,
    isPrimary: cit.isPrimary,
  };
}

function formatProperty(p: typeof properties.$inferSelect) {
  return {
    id: p.id,
    label: p.label,
    category: p.category,
    description: p.description,
    entityTypes: p.entityTypes,
    valueType: p.valueType,
    defaultUnit: p.defaultUnit,
    stalenessCadence: p.stalenessCadence,
    unitFormatId: p.unitFormatId,
  };
}

// ---- Create body schema ----

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

    return c.json({
      statements: rows.map(formatStatement),
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
      citations: citationRows.map(formatCitation),
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

  // ---- GET /by-entity — all statements for an entity, grouped by property category ----
  .get("/by-entity", zv("query", ByEntityQuery), async (c) => {
    const { entityId } = c.req.valid("query");
    const db = getDrizzleDb();

    // Fetch all active statements for this entity
    const rows = await db
      .select()
      .from(statements)
      .where(
        and(
          eq(statements.subjectEntityId, entityId),
          eq(statements.status, "active")
        )
      )
      .orderBy(asc(statements.propertyId), desc(statements.validStart));

    // Fetch citations for all returned statements in one query
    const stmtIds = rows.map((r) => r.id);
    const citations =
      stmtIds.length > 0
        ? await db
            .select()
            .from(statementCitations)
            .where(inArray(statementCitations.statementId, stmtIds))
        : [];

    // Group citations by statement ID
    const citationsByStmt = new Map<number, typeof citations>();
    for (const cit of citations) {
      const existing = citationsByStmt.get(cit.statementId) ?? [];
      existing.push(cit);
      citationsByStmt.set(cit.statementId, existing);
    }

    // Fetch properties referenced by these statements
    const propertyIds = [...new Set(rows.map((r) => r.propertyId).filter(Boolean))] as string[];
    const props =
      propertyIds.length > 0
        ? await db
            .select()
            .from(properties)
            .where(inArray(properties.id, propertyIds))
        : [];

    // Split by variety
    const structured = rows
      .filter((r) => r.variety === "structured")
      .map((r) => ({
        ...formatStatement(r),
        citations: (citationsByStmt.get(r.id) ?? []).map(formatCitation),
      }));

    const attributed = rows
      .filter((r) => r.variety === "attributed")
      .map((r) => ({
        ...formatStatement(r),
        citations: (citationsByStmt.get(r.id) ?? []).map(formatCitation),
      }));

    return c.json({
      structured,
      attributed,
      properties: props.map(formatProperty),
    });
  })

  // ---- GET /properties — full properties list with statement counts ----
  .get("/properties", async (c) => {
    const db = getDrizzleDb();

    const props = await db.select().from(properties).orderBy(asc(properties.category), asc(properties.label));

    // Count statements per property
    const stmtCounts = await db
      .select({
        propertyId: statements.propertyId,
        count: count(),
      })
      .from(statements)
      .where(eq(statements.status, "active"))
      .groupBy(statements.propertyId);

    const countMap = new Map(
      stmtCounts.map((r) => [r.propertyId, r.count])
    );

    return c.json({
      properties: props.map((p) => ({
        ...formatProperty(p),
        statementCount: countMap.get(p.id) ?? 0,
      })),
    });
  })

  // ---- GET /history — all values for entity+property over time ----
  .get("/history", zv("query", HistoryQuery), async (c) => {
    const { entityId, propertyId } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(statements)
      .where(
        and(
          eq(statements.subjectEntityId, entityId),
          eq(statements.propertyId, propertyId)
        )
      )
      .orderBy(desc(statements.validStart));

    // Fetch citations for all returned statements
    const stmtIds = rows.map((r) => r.id);
    const citations =
      stmtIds.length > 0
        ? await db
            .select()
            .from(statementCitations)
            .where(inArray(statementCitations.statementId, stmtIds))
        : [];

    const citationsByStmt = new Map<number, typeof citations>();
    for (const cit of citations) {
      const existing = citationsByStmt.get(cit.statementId) ?? [];
      existing.push(cit);
      citationsByStmt.set(cit.statementId, existing);
    }

    return c.json({
      statements: rows.map((r) => ({
        ...formatStatement(r),
        citations: (citationsByStmt.get(r.id) ?? []).map(formatCitation),
      })),
    });
  })

  // ---- GET /:id — single statement with full citations ----
  .get("/:id", async (c) => {
    const idParam = c.req.param("id");
    const id = parseInt(idParam, 10);
    if (isNaN(id)) {
      return c.json({ error: VALIDATION_ERROR, message: "Invalid statement ID" }, 400);
    }

    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(statements)
      .where(eq(statements.id, id))
      .limit(1);

    if (rows.length === 0) {
      return c.json({ error: "not_found", message: "Statement not found" }, 404);
    }

    const citationRows = await db
      .select()
      .from(statementCitations)
      .where(eq(statementCitations.statementId, id));

    // Fetch the property if the statement has one
    const stmt = rows[0];
    let property = null;
    if (stmt.propertyId) {
      const propRows = await db
        .select()
        .from(properties)
        .where(eq(properties.id, stmt.propertyId))
        .limit(1);
      if (propRows.length > 0) {
        property = formatProperty(propRows[0]);
      }
    }

    return c.json({
      statement: formatStatement(stmt),
      citations: citationRows.map(formatCitation),
      property,
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

    const PatchStatementBody = z.object({
      status: z.enum(["active", "superseded", "retracted"]).optional(),
      archiveReason: z.string().max(2000).nullish(),
      verdict: z.string().max(50).nullish(),
      verdictScore: z.number().min(0).max(1).nullish(),
      verdictQuotes: z.string().max(10000).nullish(),
      verdictModel: z.string().max(200).nullish(),
      note: z.string().max(2000).nullish(),
    });

    const parsed = PatchStatementBody.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const data = parsed.data;
    const db = getDrizzleDb();

    // Build update object with only provided fields
    const updates: Record<string, unknown> = {
      updatedAt: sql`now()`,
    };
    if (data.status !== undefined) updates.status = data.status;
    if (data.archiveReason !== undefined) updates.archiveReason = data.archiveReason ?? null;
    if (data.verdict !== undefined) updates.verdict = data.verdict ?? null;
    if (data.verdictScore !== undefined) updates.verdictScore = data.verdictScore ?? null;
    if (data.verdictQuotes !== undefined) updates.verdictQuotes = data.verdictQuotes ?? null;
    if (data.verdictModel !== undefined) updates.verdictModel = data.verdictModel ?? null;
    if (data.note !== undefined) updates.note = data.note ?? null;

    const rows = await db
      .update(statements)
      .set(updates)
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
