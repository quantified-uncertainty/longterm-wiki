import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { verificationEvidence, verificationVerdicts } from "../../schema.js";
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

const verificationsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        needsRecheck: sql<number>`count(*) filter (where ${verificationVerdicts.needsRecheck} = true)`,
        avgConfidence: sql<number>`coalesce(avg(${verificationVerdicts.confidence}), 0)`,
      })
      .from(verificationVerdicts);

    const byVerdictRows = await db
      .select({
        verdict: verificationVerdicts.verdict,
        count: count(),
      })
      .from(verificationVerdicts)
      .groupBy(verificationVerdicts.verdict);

    const byVerdict: Record<string, number> = {};
    for (const row of byVerdictRows) {
      byVerdict[row.verdict] = row.count;
    }

    const byTypeRows = await db
      .select({
        recordType: verificationVerdicts.recordType,
        count: count(),
      })
      .from(verificationVerdicts)
      .groupBy(verificationVerdicts.recordType);

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
      conditions.push(eq(verificationVerdicts.recordType, record_type));
    }
    if (verdict) {
      conditions.push(eq(verificationVerdicts.verdict, verdict));
    }
    if (needs_recheck !== undefined) {
      conditions.push(eq(verificationVerdicts.needsRecheck, needs_recheck));
    }
    if (entity_id) {
      conditions.push(eq(verificationVerdicts.entityId, entity_id));
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(verificationVerdicts)
      .where(whereClause)
      .orderBy(desc(verificationVerdicts.lastComputedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(verificationVerdicts)
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
      .from(verificationVerdicts)
      .where(
        and(
          eq(verificationVerdicts.recordType, recordType),
          eq(verificationVerdicts.recordId, recordId),
        )
      );

    if (verdictRows.length === 0) {
      return c.json({ error: "not_found", message: "Verdict not found" }, 404);
    }

    // Return all verdicts for this record (row-level + any cell-level)
    const evidenceRows = await db
      .select()
      .from(verificationEvidence)
      .where(
        and(
          eq(verificationEvidence.recordType, recordType),
          eq(verificationEvidence.recordId, recordId),
        )
      )
      .orderBy(desc(verificationEvidence.checkedAt));

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
        .from(verificationEvidence)
        .where(
          and(
            eq(verificationEvidence.recordType, recordType),
            eq(verificationEvidence.recordId, recordId),
          )
        )
        .orderBy(desc(verificationEvidence.checkedAt))
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
      .insert(verificationEvidence)
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
      .returning({ id: verificationEvidence.id });

    // Auto-flag corresponding verdicts for recheck
    const updated = await db
      .update(verificationVerdicts)
      .set({ needsRecheck: true, updatedAt: now })
      .where(
        and(
          eq(verificationVerdicts.recordType, body.recordType),
          eq(verificationVerdicts.recordId, body.recordId),
        )
      )
      .returning({ recordId: verificationVerdicts.recordId });

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

    const doUpdate = () => db.execute(sql`
      UPDATE verification_verdicts SET
        entity_id = COALESCE(${entityIdVal}, entity_id),
        verdict = ${body.verdict},
        confidence = ${body.confidence ?? null},
        reasoning = ${body.reasoning ?? null},
        sources_checked = ${body.sourcesChecked ?? 0},
        needs_recheck = false,
        next_check_due = ${body.nextCheckDue ? new Date(body.nextCheckDue) : null},
        last_computed_at = ${now},
        updated_at = ${now}
      WHERE record_type = ${body.recordType}
        AND record_id = ${body.recordId}
        AND COALESCE(field_name, '') = COALESCE(${fieldNameVal}, '')
    `);

    const updateResult = await doUpdate();
    const rowsUpdated = (updateResult as unknown as { count?: number })?.count ?? 0;

    if (rowsUpdated === 0) {
      try {
        await db.execute(sql`
          INSERT INTO verification_verdicts (
            record_type, record_id, field_name, entity_id,
            verdict, confidence, reasoning, sources_checked,
            needs_recheck, next_check_due, last_computed_at,
            created_at, updated_at
          ) VALUES (
            ${body.recordType}, ${body.recordId}, ${fieldNameVal}, ${entityIdVal},
            ${body.verdict}, ${body.confidence ?? null}, ${body.reasoning ?? null}, ${body.sourcesChecked ?? 0},
            false, ${body.nextCheckDue ? new Date(body.nextCheckDue) : null}, ${now},
            ${now}, ${now}
          )
        `);
      } catch (insertErr: unknown) {
        // Race condition: another request inserted between our UPDATE and INSERT.
        // Retry the UPDATE which should now find the row.
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("23505")) {
          await doUpdate();
        } else {
          throw insertErr;
        }
      }
    }

    return c.json({ ok: true }, 200);
  });

// ---- Exports ----

export const verificationsRoute = verificationsApp;
export type VerificationsRoute = typeof verificationsApp;
