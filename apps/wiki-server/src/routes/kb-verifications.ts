import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import {
  kbFactVerdicts,
  kbFactResourceVerifications,
  facts,
} from "../schema.js";
import { zv, notFoundError } from "./utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const MAX_FACT_ID_LENGTH = 100;

// ---- Query schemas ----

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
        needsRecheck: sql<number>`count(*) filter (where ${kbFactVerdicts.needsRecheck} = true)`,
        avgConfidence: sql<number>`coalesce(avg(${kbFactVerdicts.confidence}), 0)`,
      })
      .from(kbFactVerdicts);

    // Breakdown by verdict (still a separate query — GROUP BY can't merge into the aggregate above)
    const byVerdictRows = await db
      .select({
        verdict: kbFactVerdicts.verdict,
        count: count(),
      })
      .from(kbFactVerdicts)
      .groupBy(kbFactVerdicts.verdict);

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
      conditions.push(eq(kbFactVerdicts.verdict, verdict));
    }
    if (needs_recheck !== undefined) {
      conditions.push(eq(kbFactVerdicts.needsRecheck, needs_recheck));
    }

    // Filter by entity_id via the joined facts table
    if (entity_id) {
      conditions.push(eq(facts.entityId, entity_id));
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
        factId: kbFactVerdicts.factId,
        verdict: kbFactVerdicts.verdict,
        confidence: kbFactVerdicts.confidence,
        reasoning: kbFactVerdicts.reasoning,
        sourcesChecked: kbFactVerdicts.sourcesChecked,
        needsRecheck: kbFactVerdicts.needsRecheck,
        lastComputedAt: kbFactVerdicts.lastComputedAt,
        createdAt: kbFactVerdicts.createdAt,
        updatedAt: kbFactVerdicts.updatedAt,
        entityId: facts.entityId,
        factLabel: facts.label,
      })
      .from(kbFactVerdicts)
      .leftJoin(facts, eq(kbFactVerdicts.factId, facts.factId))
      .where(whereClause)
      .orderBy(desc(kbFactVerdicts.lastComputedAt))
      .limit(limit)
      .offset(offset);

    // Count query — needs the LEFT JOIN when filtering by entity_id
    const countQuery = entity_id
      ? db
          .select({ count: count() })
          .from(kbFactVerdicts)
          .leftJoin(facts, eq(kbFactVerdicts.factId, facts.factId))
          .where(whereClause)
      : db
          .select({ count: count() })
          .from(kbFactVerdicts)
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
      .from(kbFactVerdicts)
      .where(eq(kbFactVerdicts.factId, factId))
      .limit(1);

    if (verdictRows.length === 0) {
      return c.json({ error: "not_found", message: "Fact verdict not found" }, 404);
    }

    const verdict = verdictRows[0];

    const verifications = await db
      .select()
      .from(kbFactResourceVerifications)
      .where(eq(kbFactResourceVerifications.factId, factId))
      .orderBy(desc(kbFactResourceVerifications.checkedAt));

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
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      })),
    });
  });

// ---- Exports ----

/**
 * KB Verifications route handler -- mount at `/api/kb-verifications` in the main app.
 *
 * Also exports `KbVerificationsRoute` type for Hono RPC client type inference.
 */
export const kbVerificationsRoute = kbVerificationsApp;
export type KbVerificationsRoute = typeof kbVerificationsApp;
