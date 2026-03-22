import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { sourceCheckEvidence, sourceCheckVerdicts } from "../../schema.js";
import {
  zv,
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "../shared/utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const MAX_ID_LENGTH = 500;
const MAX_URL_LENGTH = 2048;

const VALID_VERDICTS = [
  "confirmed",
  "contradicted",
  "unverifiable",
  "outdated",
  "partial",
] as const;

const VALID_VERDICT_TYPES = [...VALID_VERDICTS, "unchecked"] as const;

// ---- Query schemas ----

const EvidenceBody = z.object({
  recordType: z.string().min(1).max(50),
  recordId: z.string().min(1).max(MAX_ID_LENGTH),
  fieldName: z.string().max(200).nullable().optional(),
  entityId: z.string().max(200).nullable().optional(),
  expectedValue: z.string().max(2000).nullable().optional(),
  resourceId: z.string().max(200).nullable().optional(),
  sourceUrl: z.string().url().max(MAX_URL_LENGTH).nullable().optional(),
  extractedValue: z.string().max(2000).nullable().optional(),
  extractedQuote: z.string().max(5000).nullable().optional(),
  verdict: z.enum(VALID_VERDICTS),
  confidence: z.number().min(0).max(1).nullable().optional(),
  isPrimarySource: z.boolean().default(false),
  checkerModel: z.string().max(100).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const VerdictUpsertBody = z.object({
  recordType: z.string().min(1).max(50),
  recordId: z.string().min(1).max(MAX_ID_LENGTH),
  fieldName: z.string().max(200).nullable().optional(),
  entityId: z.string().max(200).nullable().optional(),
  verdict: z.enum(VALID_VERDICT_TYPES),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().max(5000).optional(),
  sourcesChecked: z.number().int().min(0).optional(),
  nextCheckDue: z.string().datetime().optional(),
});

const VerdictsQuery = z.object({
  record_type: z.string().max(50).optional(),
  verdict: z.string().max(50).optional(),
  entity_id: z.string().max(200).optional(),
  needs_recheck: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const EvidenceQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Route definition (method-chained for Hono RPC type inference) ----

const sourceChecksApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        needsRecheck: sql<number>`count(*) filter (where ${sourceCheckVerdicts.needsRecheck} = true)`,
        avgConfidence: sql<number>`coalesce(avg(${sourceCheckVerdicts.confidence}), 0)`,
      })
      .from(sourceCheckVerdicts);

    const byVerdictRows = await db
      .select({
        verdict: sourceCheckVerdicts.verdict,
        count: count(),
      })
      .from(sourceCheckVerdicts)
      .groupBy(sourceCheckVerdicts.verdict);

    const byVerdict: Record<string, number> = {};
    for (const row of byVerdictRows) {
      byVerdict[row.verdict] = row.count;
    }

    const byTypeRows = await db
      .select({
        recordType: sourceCheckVerdicts.recordType,
        count: count(),
      })
      .from(sourceCheckVerdicts)
      .groupBy(sourceCheckVerdicts.recordType);

    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      byType[row.recordType] = row.count;
    }

    return c.json({
      total: statsRow.total,
      by_verdict: byVerdict,
      by_type: byType,
      needs_recheck: Number(statsRow.needsRecheck),
      avg_confidence: Math.round(Number(statsRow.avgConfidence) * 100) / 100,
    });
  })

  // ---- GET /verdicts ----
  .get("/verdicts", zv("query", VerdictsQuery), async (c) => {
    const { record_type, verdict, entity_id, needs_recheck, limit, offset } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (record_type) {
      conditions.push(eq(sourceCheckVerdicts.recordType, record_type));
    }
    if (verdict) {
      conditions.push(eq(sourceCheckVerdicts.verdict, verdict));
    }
    if (needs_recheck !== undefined) {
      conditions.push(eq(sourceCheckVerdicts.needsRecheck, needs_recheck));
    }
    if (entity_id) {
      conditions.push(eq(sourceCheckVerdicts.entityId, entity_id));
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(sourceCheckVerdicts)
      .where(whereClause)
      .orderBy(desc(sourceCheckVerdicts.lastComputedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(sourceCheckVerdicts)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      verdicts: rows.map((r) => ({
        recordType: r.recordType,
        recordId: r.recordId,
        fieldName: r.fieldName,
        entityId: r.entityId,
        verdict: r.verdict,
        confidence: r.confidence,
        reasoning: r.reasoning,
        sourcesChecked: r.sourcesChecked,
        needsRecheck: r.needsRecheck,
        nextCheckDue: r.nextCheckDue,
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

    if (recordId.length > MAX_ID_LENGTH) {
      return c.json({ error: "not_found", message: "Verdict not found" }, 404);
    }

    const db = getDrizzleDb();

    const verdictRows = await db
      .select()
      .from(sourceCheckVerdicts)
      .where(
        and(
          eq(sourceCheckVerdicts.recordType, recordType),
          eq(sourceCheckVerdicts.recordId, recordId),
        )
      );

    if (verdictRows.length === 0) {
      return c.json({ error: "not_found", message: "Verdict not found" }, 404);
    }

    // Return all verdicts for this record (row-level + any cell-level)
    const evidenceRows = await db
      .select()
      .from(sourceCheckEvidence)
      .where(
        and(
          eq(sourceCheckEvidence.recordType, recordType),
          eq(sourceCheckEvidence.recordId, recordId),
        )
      )
      .orderBy(desc(sourceCheckEvidence.checkedAt));

    return c.json({
      verdicts: verdictRows.map((v) => ({
        recordType: v.recordType,
        recordId: v.recordId,
        fieldName: v.fieldName,
        entityId: v.entityId,
        verdict: v.verdict,
        confidence: v.confidence,
        reasoning: v.reasoning,
        sourcesChecked: v.sourcesChecked,
        needsRecheck: v.needsRecheck,
        nextCheckDue: v.nextCheckDue,
        lastComputedAt: v.lastComputedAt,
      })),
      evidence: evidenceRows.map((e) => ({
        id: e.id,
        recordType: e.recordType,
        recordId: e.recordId,
        fieldName: e.fieldName,
        entityId: e.entityId,
        expectedValue: e.expectedValue,
        resourceId: e.resourceId,
        sourceUrl: e.sourceUrl,
        extractedValue: e.extractedValue,
        extractedQuote: e.extractedQuote,
        verdict: e.verdict,
        confidence: e.confidence,
        isPrimarySource: e.isPrimarySource,
        checkerModel: e.checkerModel,
        notes: e.notes,
        checkedAt: e.checkedAt,
      })),
    });
  })

  // ---- GET /evidence/:recordType/:recordId ----
  .get(
    "/evidence/:recordType/:recordId",
    zv("query", EvidenceQuery),
    async (c) => {
      const recordType = c.req.param("recordType");
      const recordId = c.req.param("recordId");
      const { limit, offset } = c.req.valid("query");

      if (recordId.length > MAX_ID_LENGTH) {
        return c.json({ evidence: [] });
      }

      const db = getDrizzleDb();

      const rows = await db
        .select()
        .from(sourceCheckEvidence)
        .where(
          and(
            eq(sourceCheckEvidence.recordType, recordType),
            eq(sourceCheckEvidence.recordId, recordId),
          )
        )
        .orderBy(desc(sourceCheckEvidence.checkedAt))
        .limit(limit)
        .offset(offset);

      return c.json({
        evidence: rows.map((e) => ({
          id: e.id,
          recordType: e.recordType,
          recordId: e.recordId,
          fieldName: e.fieldName,
          entityId: e.entityId,
          expectedValue: e.expectedValue,
          resourceId: e.resourceId,
          sourceUrl: e.sourceUrl,
          extractedValue: e.extractedValue,
          extractedQuote: e.extractedQuote,
          verdict: e.verdict,
          confidence: e.confidence,
          isPrimarySource: e.isPrimarySource,
          checkerModel: e.checkerModel,
          notes: e.notes,
          checkedAt: e.checkedAt,
        })),
      });
    }
  )

  // ---- POST /evidence ----
  .post("/evidence", async (c) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const parsed = EvidenceBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const body = parsed.data;
    const db = getDrizzleDb();
    const now = new Date();

    const [inserted] = await db
      .insert(sourceCheckEvidence)
      .values({
        recordType: body.recordType,
        recordId: body.recordId,
        fieldName: body.fieldName ?? null,
        entityId: body.entityId ?? null,
        expectedValue: body.expectedValue ?? null,
        resourceId: body.resourceId ?? null,
        sourceUrl: body.sourceUrl ?? null,
        extractedValue: body.extractedValue ?? null,
        extractedQuote: body.extractedQuote ?? null,
        verdict: body.verdict,
        confidence: body.confidence ?? null,
        isPrimarySource: body.isPrimarySource,
        checkerModel: body.checkerModel ?? null,
        notes: body.notes ?? null,
        checkedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: sourceCheckEvidence.id });

    // Auto-flag corresponding verdicts for recheck
    const updated = await db
      .update(sourceCheckVerdicts)
      .set({ needsRecheck: true, updatedAt: now })
      .where(
        and(
          eq(sourceCheckVerdicts.recordType, body.recordType),
          eq(sourceCheckVerdicts.recordId, body.recordId),
        )
      )
      .returning({ recordId: sourceCheckVerdicts.recordId });

    return c.json(
      {
        id: inserted.id,
        verdictFlagged: updated.length > 0,
      },
      201
    );
  })

  // ---- POST /verdicts ----
  .post("/verdicts", async (c) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const parsed = VerdictUpsertBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const body = parsed.data;
    const db = getDrizzleDb();
    const now = new Date();

    // Two-step upsert: try UPDATE first, INSERT if no rows affected.
    // This avoids ON CONFLICT with COALESCE expression which has compatibility
    // issues across PG versions with the postgres.js driver.
    const fieldNameVal = body.fieldName ?? null;
    const entityIdVal = body.entityId ?? null;

    // Use Drizzle ORM insert/update instead of raw SQL to avoid driver issues
    // with bare literals and COALESCE expressions.
    const fieldNameForLookup = fieldNameVal ?? "";
    const confidenceVal = body.confidence ?? null;
    const reasoningVal = body.reasoning ?? null;
    const sourcesCheckedVal = body.sourcesChecked ?? 0;
    const nextCheckDueVal = body.nextCheckDue ? new Date(body.nextCheckDue) : null;

    // Try update first
    const updated = await db
      .update(sourceCheckVerdicts)
      .set({
        entityId: entityIdVal,
        verdict: body.verdict,
        confidence: confidenceVal,
        reasoning: reasoningVal,
        sourcesChecked: sourcesCheckedVal,
        needsRecheck: false,
        nextCheckDue: nextCheckDueVal,
        lastComputedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(sourceCheckVerdicts.recordType, body.recordType),
          eq(sourceCheckVerdicts.recordId, body.recordId),
          sql`COALESCE(${sourceCheckVerdicts.fieldName}, '') = ${fieldNameForLookup}`,
        )
      )
      .returning({ recordId: sourceCheckVerdicts.recordId });

    if (updated.length === 0) {
      try {
        await db
          .insert(sourceCheckVerdicts)
          .values({
            recordType: body.recordType,
            recordId: body.recordId,
            fieldName: fieldNameVal,
            entityId: entityIdVal,
            verdict: body.verdict,
            confidence: confidenceVal,
            reasoning: reasoningVal,
            sourcesChecked: sourcesCheckedVal,
            needsRecheck: false,
            nextCheckDue: nextCheckDueVal,
            lastComputedAt: now,
            createdAt: now,
            updatedAt: now,
          });
      } catch (insertErr: unknown) {
        // Race condition: another request inserted between our UPDATE and INSERT.
        // Retry the UPDATE which should now find the row.
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("23505")) {
          await db
            .update(sourceCheckVerdicts)
            .set({
              entityId: entityIdVal,
              verdict: body.verdict,
              confidence: confidenceVal,
              reasoning: reasoningVal,
              sourcesChecked: sourcesCheckedVal,
              needsRecheck: false,
              nextCheckDue: nextCheckDueVal,
              lastComputedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(sourceCheckVerdicts.recordType, body.recordType),
                eq(sourceCheckVerdicts.recordId, body.recordId),
                sql`COALESCE(${sourceCheckVerdicts.fieldName}, '') = ${fieldNameForLookup}`,
              )
            );
        } else {
          throw insertErr;
        }
      }
    }

    return c.json({ ok: true }, 200);
  });

// ---- Exports ----

export const sourceChecksRoute = sourceChecksApp;
export type SourceChecksRoute = typeof sourceChecksApp;
