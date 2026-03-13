import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { recordVerifications, recordVerdicts } from "../schema.js";
import {
  zv,
  notFoundError,
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "./utils.js";
import {
  VALID_RECORD_TYPES,
  VALID_VERIFICATION_VERDICTS,
} from "../api-types.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const MAX_ID_LENGTH = 10;
const MAX_URL_LENGTH = 2048;

// ---- Query schemas ----

const VerificationBody = z.object({
  recordType: z.enum(VALID_RECORD_TYPES),
  recordId: z.string().min(1).max(MAX_ID_LENGTH),
  fieldName: z.string().max(100).optional(),
  expectedValue: z.string().max(2000).optional(),
  sourceUrl: z.string().url().max(MAX_URL_LENGTH).optional(),
  verdict: z.enum(VALID_VERIFICATION_VERDICTS),
  confidence: z.number().min(0).max(1).optional(),
  extractedValue: z.string().max(2000).optional(),
  checkerModel: z.string().max(100).optional(),
  notes: z.string().max(5000).optional(),
});

const VerdictUpsertBody = z.object({
  recordType: z.enum(VALID_RECORD_TYPES),
  recordId: z.string().min(1).max(MAX_ID_LENGTH),
  verdict: z.enum([...VALID_VERIFICATION_VERDICTS, "unchecked"]),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().max(5000).optional(),
  sourcesChecked: z.number().int().min(0).optional(),
});

const VerdictsQuery = z.object({
  record_type: z.string().max(50).optional(),
  verdict: z.string().max(50).optional(),
  needs_recheck: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ByRecordQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Route definition (method-chained for Hono RPC type inference) ----

const recordVerificationsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        needsRecheck: sql<number>`count(*) filter (where ${recordVerdicts.needsRecheck} = true)`,
        avgConfidence: sql<number>`coalesce(avg(${recordVerdicts.confidence}), 0)`,
      })
      .from(recordVerdicts);

    const byVerdictRows = await db
      .select({
        verdict: recordVerdicts.verdict,
        count: count(),
      })
      .from(recordVerdicts)
      .groupBy(recordVerdicts.verdict);

    const byVerdict: Record<string, number> = {};
    for (const row of byVerdictRows) {
      byVerdict[row.verdict] = row.count;
    }

    const byTypeRows = await db
      .select({
        recordType: recordVerdicts.recordType,
        count: count(),
      })
      .from(recordVerdicts)
      .groupBy(recordVerdicts.recordType);

    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      byType[row.recordType] = row.count;
    }

    return c.json({
      total_records: statsRow.total,
      by_verdict: byVerdict,
      by_type: byType,
      needs_recheck: Number(statsRow.needsRecheck),
      avg_confidence:
        Math.round(Number(statsRow.avgConfidence) * 100) / 100,
    });
  })

  // ---- GET /verdicts ----
  .get("/verdicts", zv("query", VerdictsQuery), async (c) => {
    const { record_type, verdict, needs_recheck, limit, offset } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (record_type) {
      conditions.push(eq(recordVerdicts.recordType, record_type));
    }
    if (verdict) {
      conditions.push(eq(recordVerdicts.verdict, verdict));
    }
    if (needs_recheck !== undefined) {
      conditions.push(eq(recordVerdicts.needsRecheck, needs_recheck));
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(recordVerdicts)
      .where(whereClause)
      .orderBy(desc(recordVerdicts.lastComputedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(recordVerdicts)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      verdicts: rows.map((r) => ({
        recordType: r.recordType,
        recordId: r.recordId,
        verdict: r.verdict,
        confidence: r.confidence,
        reasoning: r.reasoning,
        sourcesChecked: r.sourcesChecked,
        needsRecheck: r.needsRecheck,
        lastComputedAt: r.lastComputedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      total,
    });
  })

  // ---- GET /verdicts/:recordType/:recordId ----
  .get("/verdicts/:recordType/:recordId", async (c) => {
    const recordType = c.req.param("recordType");
    const recordId = c.req.param("recordId");

    if (
      recordId.length > MAX_ID_LENGTH ||
      !(VALID_RECORD_TYPES as readonly string[]).includes(recordType)
    ) {
      return c.json(
        { error: "not_found", message: "Record verdict not found" },
        404
      );
    }

    const db = getDrizzleDb();

    const verdictRows = await db
      .select()
      .from(recordVerdicts)
      .where(
        and(
          eq(recordVerdicts.recordType, recordType),
          eq(recordVerdicts.recordId, recordId)
        )
      )
      .limit(1);

    if (verdictRows.length === 0) {
      return c.json(
        { error: "not_found", message: "Record verdict not found" },
        404
      );
    }

    const verdict = verdictRows[0];

    const verifications = await db
      .select()
      .from(recordVerifications)
      .where(
        and(
          eq(recordVerifications.recordType, recordType),
          eq(recordVerifications.recordId, recordId)
        )
      )
      .orderBy(desc(recordVerifications.checkedAt));

    return c.json({
      verdict: {
        recordType: verdict.recordType,
        recordId: verdict.recordId,
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
        sourcesChecked: verdict.sourcesChecked,
        needsRecheck: verdict.needsRecheck,
        lastComputedAt: verdict.lastComputedAt,
        createdAt: verdict.createdAt,
        updatedAt: verdict.updatedAt,
      },
      verifications: verifications.map((v) => ({
        id: v.id,
        recordType: v.recordType,
        recordId: v.recordId,
        fieldName: v.fieldName,
        expectedValue: v.expectedValue,
        sourceUrl: v.sourceUrl,
        verdict: v.verdict,
        confidence: v.confidence,
        extractedValue: v.extractedValue,
        checkerModel: v.checkerModel,
        notes: v.notes,
        checkedAt: v.checkedAt,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      })),
    });
  })

  // ---- GET /by-record/:recordType/:recordId ----
  // Get all verifications for a specific record (without the verdict)
  .get(
    "/by-record/:recordType/:recordId",
    zv("query", ByRecordQuery),
    async (c) => {
      const recordType = c.req.param("recordType");
      const recordId = c.req.param("recordId");

      if (
        recordId.length > MAX_ID_LENGTH ||
        !(VALID_RECORD_TYPES as readonly string[]).includes(recordType)
      ) {
        return c.json({ verifications: [] });
      }

      const { limit, offset } = c.req.valid("query");
      const db = getDrizzleDb();

      const rows = await db
        .select()
        .from(recordVerifications)
        .where(
          and(
            eq(recordVerifications.recordType, recordType),
            eq(recordVerifications.recordId, recordId)
          )
        )
        .orderBy(desc(recordVerifications.checkedAt))
        .limit(limit)
        .offset(offset);

      return c.json({
        verifications: rows.map((v) => ({
          id: v.id,
          recordType: v.recordType,
          recordId: v.recordId,
          fieldName: v.fieldName,
          expectedValue: v.expectedValue,
          sourceUrl: v.sourceUrl,
          verdict: v.verdict,
          confidence: v.confidence,
          extractedValue: v.extractedValue,
          checkerModel: v.checkerModel,
          notes: v.notes,
          checkedAt: v.checkedAt,
          createdAt: v.createdAt,
          updatedAt: v.updatedAt,
        })),
      });
    }
  )

  // ---- POST /verifications ----
  .post("/verifications", async (c) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const parsed = VerificationBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const body = parsed.data;
    const db = getDrizzleDb();
    const now = new Date();

    const [inserted] = await db
      .insert(recordVerifications)
      .values({
        recordType: body.recordType,
        recordId: body.recordId,
        fieldName: body.fieldName ?? null,
        expectedValue: body.expectedValue ?? null,
        sourceUrl: body.sourceUrl ?? null,
        verdict: body.verdict,
        confidence: body.confidence ?? null,
        extractedValue: body.extractedValue ?? null,
        checkerModel: body.checkerModel ?? null,
        notes: body.notes ?? null,
        checkedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: recordVerifications.id });

    // Auto-flag the corresponding verdict for recheck
    const updated = await db
      .update(recordVerdicts)
      .set({ needsRecheck: true, updatedAt: now })
      .where(
        and(
          eq(recordVerdicts.recordType, body.recordType),
          eq(recordVerdicts.recordId, body.recordId)
        )
      )
      .returning({ recordId: recordVerdicts.recordId });

    return c.json(
      {
        id: inserted.id,
        verdictFlagged: updated.length > 0,
      },
      201
    );
  })

  // ---- POST /verdicts ----
  // Upsert an aggregate verdict for a record
  .post("/verdicts", async (c) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const parsed = VerdictUpsertBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const body = parsed.data;
    const db = getDrizzleDb();
    const now = new Date();

    await db
      .insert(recordVerdicts)
      .values({
        recordType: body.recordType,
        recordId: body.recordId,
        verdict: body.verdict,
        confidence: body.confidence ?? null,
        reasoning: body.reasoning ?? null,
        sourcesChecked: body.sourcesChecked ?? 0,
        needsRecheck: false,
        lastComputedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [recordVerdicts.recordType, recordVerdicts.recordId],
        set: {
          verdict: body.verdict,
          confidence: body.confidence ?? null,
          reasoning: body.reasoning ?? null,
          sourcesChecked: body.sourcesChecked ?? 0,
          needsRecheck: false,
          lastComputedAt: now,
          updatedAt: now,
        },
      });

    return c.json({ ok: true }, 200);
  });

// ---- Exports ----

export const recordVerificationsRoute = recordVerificationsApp;
export type RecordVerificationsRoute = typeof recordVerificationsApp;
