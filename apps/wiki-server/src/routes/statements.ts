/**
 * Statements route — Hono RPC method-chained route for the Statements system.
 *
 * Phase 1c: Minimal CRUD for statements + citations.
 * - GET /          — list with filters (by entity, property, variety, status)
 * - GET /current   — current value for entity+property (valid_end IS NULL)
 * - POST /         — create statement + citations
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
    sourceFactKey: s.sourceFactKey,
    note: s.note,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
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

    // Insert statement
    const result = await db
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

    const statementId = result[0].id;

    // Insert citations if provided
    if (data.citations.length > 0) {
      await db.insert(statementCitations).values(
        data.citations.map((cit) => ({
          statementId,
          resourceId: cit.resourceId ?? null,
          url: cit.url ?? null,
          sourceQuote: cit.sourceQuote ?? null,
          locationNote: cit.locationNote ?? null,
          isPrimary: cit.isPrimary,
        }))
      );
    }

    return c.json({ id: statementId, ok: true }, 201);
  });

export const statementsRoute = statementsApp;
export type StatementsRoute = typeof statementsApp;
