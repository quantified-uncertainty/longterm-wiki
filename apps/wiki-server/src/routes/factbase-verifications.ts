import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql, desc, or } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import {
  factbaseVerdicts,
  factbaseResourceVerifications,
  facts,
  entities,
} from "../schema.js";
import {
  zv,
  notFoundError,
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "./utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const MAX_FACT_ID_LENGTH = 100;
const MAX_URL_LENGTH = 2048;

// ---- Valid verdict values ----

const VALID_RESOURCE_VERDICTS = [
  "confirmed",
  "contradicted",
  "unverifiable",
  "outdated",
  "partial",
] as const;

// ---- Query schemas ----

const ResourceVerificationBody = z.object({
  factId: z.string().min(1).max(MAX_FACT_ID_LENGTH),
  resourceId: z.string().max(200).optional(),
  verdict: z.enum(VALID_RESOURCE_VERDICTS),
  confidence: z.number().min(0).max(1).optional(),
  extractedValue: z.string().max(2000).optional(),
  checkerModel: z.string().max(100).optional(),
  isPrimarySource: z.boolean().default(false),
  notes: z.string().max(5000).optional(),
  sourceUrl: z.string().url().max(MAX_URL_LENGTH).optional(),
});

const VerdictsQuery = z.object({
  verdict: z.string().max(50).optional(),
  needs_recheck: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  entity_id: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Route definition (method-chained for Hono RPC type inference) ----

const kbVerificationsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    // Single aggregation query instead of 4 sequential queries
    const [statsRow] = await db
      .select({
        total: count(),
        needsRecheck: sql<number>`count(*) filter (where ${factbaseVerdicts.needsRecheck} = true)`,
        avgConfidence: sql<number>`coalesce(avg(${factbaseVerdicts.confidence}), 0)`,
      })
      .from(factbaseVerdicts);

    // Breakdown by verdict (still a separate query — GROUP BY can't merge into the aggregate above)
    const byVerdictRows = await db
      .select({
        verdict: factbaseVerdicts.verdict,
        count: count(),
      })
      .from(factbaseVerdicts)
      .groupBy(factbaseVerdicts.verdict);

    const byVerdict: Record<string, number> = {};
    for (const row of byVerdictRows) {
      byVerdict[row.verdict] = row.count;
    }

    return c.json({
      total_facts: statsRow.total,
      by_verdict: byVerdict,
      needs_recheck: Number(statsRow.needsRecheck),
      avg_confidence: Math.round(Number(statsRow.avgConfidence) * 100) / 100,
    });
  })

  // ---- GET /verdicts ----
  .get("/verdicts", zv("query", VerdictsQuery), async (c) => {
    const { verdict, needs_recheck, entity_id, limit, offset } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (verdict) {
      conditions.push(eq(factbaseVerdicts.verdict, verdict));
    }
    if (needs_recheck !== undefined) {
      conditions.push(eq(factbaseVerdicts.needsRecheck, needs_recheck));
    }

    // Filter by entity_id via the joined facts table.
    // Resolve slug/numericId to stableId since facts.entity_id stores stableIds.
    if (entity_id) {
      const resolved = await (async () => {
        const rows = await db
          .select({ stableId: entities.stableId })
          .from(entities)
          .where(
            or(
              eq(entities.stableId, entity_id),
              eq(entities.id, entity_id),
              eq(entities.numericId, entity_id),
            )
          )
          .limit(1);
        return rows[0]?.stableId ?? entity_id;
      })();
      conditions.push(eq(facts.entityId, resolved));
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    // LEFT JOIN facts to get entityId and label for each verdict.
    // Note: the facts table's unique key is (entityId, factId), not factId alone.
    // In practice, KB fact IDs are random hashes (e.g., "f_abc123") that are
    // unique across all entities, so this JOIN is 1:1. If that assumption ever
    // breaks, switch to a DISTINCT ON subquery.
    const rows = await db
      .select({
        factId: factbaseVerdicts.factId,
        verdict: factbaseVerdicts.verdict,
        confidence: factbaseVerdicts.confidence,
        reasoning: factbaseVerdicts.reasoning,
        sourcesChecked: factbaseVerdicts.sourcesChecked,
        needsRecheck: factbaseVerdicts.needsRecheck,
        lastComputedAt: factbaseVerdicts.lastComputedAt,
        createdAt: factbaseVerdicts.createdAt,
        updatedAt: factbaseVerdicts.updatedAt,
        entityId: facts.entityId,
        factLabel: facts.label,
      })
      .from(factbaseVerdicts)
      .leftJoin(facts, eq(factbaseVerdicts.factId, facts.factId))
      .where(whereClause)
      .orderBy(desc(factbaseVerdicts.lastComputedAt))
      .limit(limit)
      .offset(offset);

    // Count query — needs the LEFT JOIN when filtering by entity_id
    const countQuery = entity_id
      ? db
          .select({ count: count() })
          .from(factbaseVerdicts)
          .leftJoin(facts, eq(factbaseVerdicts.factId, facts.factId))
          .where(whereClause)
      : db
          .select({ count: count() })
          .from(factbaseVerdicts)
          .where(whereClause);
    const countResult = await countQuery;
    const total = countResult[0].count;

    return c.json({
      verdicts: rows.map((r) => ({
        factId: r.factId,
        verdict: r.verdict,
        confidence: r.confidence,
        reasoning: r.reasoning,
        sourcesChecked: r.sourcesChecked,
        needsRecheck: r.needsRecheck,
        lastComputedAt: r.lastComputedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        entityId: r.entityId,
        factLabel: r.factLabel,
      })),
      total,
    });
  })

  // ---- GET /verdicts/:factId ----
  .get("/verdicts/:factId", async (c) => {
    const factId = c.req.param("factId");

    // Validate path param length
    if (factId.length > MAX_FACT_ID_LENGTH) {
      return notFoundError(c, "Fact verdict not found");
    }

    const db = getDrizzleDb();

    const verdictRows = await db
      .select()
      .from(factbaseVerdicts)
      .where(eq(factbaseVerdicts.factId, factId))
      .limit(1);

    if (verdictRows.length === 0) {
      return c.json({ error: "not_found", message: "Fact verdict not found" }, 404);
    }

    const verdict = verdictRows[0];

    const verifications = await db
      .select()
      .from(factbaseResourceVerifications)
      .where(eq(factbaseResourceVerifications.factId, factId))
      .orderBy(desc(factbaseResourceVerifications.checkedAt));

    return c.json({
      verdict: {
        factId: verdict.factId,
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
        factId: v.factId,
        resourceId: v.resourceId,
        verdict: v.verdict,
        confidence: v.confidence,
        extractedValue: v.extractedValue,
        checkerModel: v.checkerModel,
        isPrimarySource: v.isPrimarySource,
        checkedAt: v.checkedAt,
        notes: v.notes,
        sourceUrl: v.sourceUrl,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      })),
    });
  })

  // ---- POST /verifications ----
  .post("/verifications", async (c) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const parsed = ResourceVerificationBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const body = parsed.data;
    const db = getDrizzleDb();

    const now = new Date();

    // Insert the resource verification
    const [inserted] = await db
      .insert(factbaseResourceVerifications)
      .values({
        factId: body.factId,
        resourceId: body.resourceId ?? null,
        verdict: body.verdict,
        confidence: body.confidence ?? null,
        extractedValue: body.extractedValue ?? null,
        checkerModel: body.checkerModel ?? null,
        isPrimarySource: body.isPrimarySource,
        notes: body.notes ?? null,
        sourceUrl: body.sourceUrl ?? null,
        checkedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: factbaseResourceVerifications.id });

    // Auto-set needs_recheck on the corresponding verdict if one exists.
    // When new evidence is inserted, the aggregate verdict may be stale.
    const updated = await db
      .update(factbaseVerdicts)
      .set({ needsRecheck: true, updatedAt: now })
      .where(eq(factbaseVerdicts.factId, body.factId))
      .returning({ factId: factbaseVerdicts.factId });

    return c.json({
      id: inserted.id,
      verdictFlagged: updated.length > 0,
    }, 201);
  });

// ---- Exports ----

/**
 * KB Verifications route handler -- mount at `/api/kb-verifications` in the main app.
 *
 * Also exports `KbVerificationsRoute` type for Hono RPC client type inference.
 */
export const factbaseVerificationsRoute = kbVerificationsApp;
export type FactbaseVerificationsRoute = typeof kbVerificationsApp;
