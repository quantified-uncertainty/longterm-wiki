import { Hono } from "hono";
import { z } from "zod";
import {
  eq,
  and,
  or,
  count,
  sql,
  desc,
  lte,
  inArray,
  countDistinct,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import {
  sourceCheckEvidence,
  sourceCheckVerdicts,
  personnel,
  entities,
  divisions,
  things,
  facts,
  publications,
  benchmarkResults,
  benchmarks,
  entityEvents,
  entityAssessments,
  secondaryMarketPrices,
} from "../../schema.js";
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

const DueForRecheckQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  record_type: z.string().max(50).optional(),
  min_priority: z.coerce.number().optional(),
});

const ResolveNamesQuery = z.object({
  record_type: z.string().min(1).max(50),
  record_ids: z
    .string()
    .min(1)
    .max(10000)
    .transform((v) =>
      v
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    ),
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
  })

  // ---- GET /resolve-names ----
  .get("/resolve-names", zv("query", ResolveNamesQuery), async (c) => {
    const { record_type, record_ids } = c.req.valid("query");
    const db = getDrizzleDb();

    if (record_ids.length === 0) {
      return c.json({ names: {} as Record<string, string> });
    }

    const names: Record<string, string> = {};

    if (record_type === "personnel") {
      // Personnel: join with entities to get person name + org name
      const personEntity = alias(entities, "person_entity");
      const orgEntity = alias(entities, "org_entity");

      const rows = await db
        .select({
          id: personnel.id,
          personDisplayName: personnel.personDisplayName,
          personEntityTitle: personEntity.title,
          orgDisplayName: personnel.orgDisplayName,
          orgEntityTitle: orgEntity.title,
        })
        .from(personnel)
        .leftJoin(
          personEntity,
          eq(personEntity.stableId, personnel.personEntityId)
        )
        .leftJoin(orgEntity, eq(orgEntity.stableId, personnel.orgEntityId))
        .where(inArray(personnel.id, record_ids));

      for (const row of rows) {
        const personName =
          row.personDisplayName ?? row.personEntityTitle ?? "Unknown";
        const orgName = row.orgDisplayName ?? row.orgEntityTitle;
        names[row.id] = orgName ? `${personName} @ ${orgName}` : personName;
      }
    } else if (record_type === "division") {
      const rows = await db
        .select({ id: divisions.id, name: divisions.name })
        .from(divisions)
        .where(inArray(divisions.id, record_ids));

      for (const row of rows) {
        names[row.id] = row.name;
      }
    } else if (record_type === "fact") {
      // Resolve fact IDs to human-readable labels (e.g. "Headquarters")
      const rows = await db
        .select({ factId: facts.factId, label: facts.label })
        .from(facts)
        .where(inArray(facts.factId, record_ids));

      // Deduplicate: same factId may appear in multiple timeseries points
      for (const row of rows) {
        if (row.label && !names[row.factId]) {
          names[row.factId] = row.label;
        }
      }
    } else if (record_type === "entity") {
      // Resolve entity stableIds to human-readable titles
      const rows = await db
        .select({ stableId: entities.stableId, title: entities.title })
        .from(entities)
        .where(inArray(entities.stableId, record_ids));

      for (const row of rows) {
        if (row.stableId && row.title) {
          names[row.stableId] = row.title;
        }
      }
    } else if (record_type === "publication") {
      const rows = await db
        .select({ id: publications.id, title: publications.title })
        .from(publications)
        .where(inArray(publications.id, record_ids));

      for (const row of rows) {
        names[row.id] = row.title;
      }
    } else if (record_type === "benchmark-result") {
      const rows = await db
        .select({
          id: benchmarkResults.id,
          benchmarkName: benchmarks.name,
          modelId: benchmarkResults.modelId,
          score: benchmarkResults.score,
        })
        .from(benchmarkResults)
        .leftJoin(benchmarks, eq(benchmarks.id, benchmarkResults.benchmarkId))
        .where(inArray(benchmarkResults.id, record_ids));

      for (const row of rows) {
        const bmName = row.benchmarkName ?? "Unknown benchmark";
        const score = row.score != null ? String(row.score) : "?";
        names[row.id] = `${row.modelId} / ${bmName}: ${score}`;
      }
    } else if (record_type === "entity-event") {
      const rows = await db
        .select({ id: entityEvents.id, title: entityEvents.title })
        .from(entityEvents)
        .where(inArray(entityEvents.id, record_ids));

      for (const row of rows) {
        names[row.id] = row.title;
      }
    } else if (record_type === "entity-assessment") {
      const rows = await db
        .select({
          id: entityAssessments.id,
          dimension: entityAssessments.dimension,
          entityId: entityAssessments.entityId,
          rating: entityAssessments.rating,
        })
        .from(entityAssessments)
        .where(inArray(entityAssessments.id, record_ids));

      for (const row of rows) {
        names[row.id] = `${row.dimension} (${row.entityId}): ${row.rating}`;
      }
    } else if (record_type === "secondary-market-price") {
      const rows = await db
        .select({
          id: secondaryMarketPrices.id,
          companyDisplayName: secondaryMarketPrices.companyDisplayName,
          companyId: secondaryMarketPrices.companyId,
          date: secondaryMarketPrices.date,
          platform: secondaryMarketPrices.platform,
        })
        .from(secondaryMarketPrices)
        .where(inArray(secondaryMarketPrices.id, record_ids));

      for (const row of rows) {
        const company = row.companyDisplayName ?? row.companyId;
        names[row.id] = `${company} (${row.platform}) ${row.date}`;
      }
    } else {
      // Generic fallback: use the things table
      const rows = await db
        .select({
          sourceId: things.sourceId,
          title: things.title,
        })
        .from(things)
        .where(
          and(
            eq(things.sourceTable, record_type),
            inArray(things.sourceId, record_ids)
          )
        );

      for (const row of rows) {
        names[row.sourceId] = row.title;
      }
    }

    return c.json({ names });
  })

  // ---- GET /coverage ----
  .get("/coverage", async (c) => {
    const db = getDrizzleDb();

    // Count total records per table using raw SQL UNION ALL
    const tableCountResult = await db.execute(sql`
      SELECT 'personnel' AS table_name, count(*)::int AS total FROM personnel
      UNION ALL
      SELECT 'division', count(*)::int FROM divisions
      UNION ALL
      SELECT 'grant', count(*)::int FROM grants
      UNION ALL
      SELECT 'funding-round', count(*)::int FROM funding_rounds
      UNION ALL
      SELECT 'investment', count(*)::int FROM investments
      UNION ALL
      SELECT 'funding-program', count(*)::int FROM funding_programs
      UNION ALL
      SELECT 'publication', count(*)::int FROM publications
      UNION ALL
      SELECT 'secondary-market-price', count(*)::int FROM secondary_market_prices
      UNION ALL
      SELECT 'equity-position', count(*)::int FROM equity_positions
      UNION ALL
      SELECT 'entity-event', count(*)::int FROM entity_events
      UNION ALL
      SELECT 'entity-assessment', count(*)::int FROM entity_assessments
      UNION ALL
      SELECT 'benchmark-result', count(*)::int FROM benchmark_results
      UNION ALL
      SELECT 'policy-stakeholder', count(*)::int FROM policy_stakeholders
    `);

    const totalsByType: Record<string, number> = {};
    for (const row of tableCountResult) {
      const r = row as { table_name: string; total: number };
      totalsByType[r.table_name] = r.total;
    }

    // Count distinct verified records per record_type from verification_verdicts
    const verifiedRows = await db
      .select({
        recordType: sourceCheckVerdicts.recordType,
        verified: countDistinct(sourceCheckVerdicts.recordId),
      })
      .from(sourceCheckVerdicts)
      .groupBy(sourceCheckVerdicts.recordType);

    const verifiedByType: Record<string, number> = {};
    for (const row of verifiedRows) {
      verifiedByType[row.recordType] = row.verified;
    }

    // Merge into coverage array — include all known types
    const allTypes = new Set([
      ...Object.keys(totalsByType),
      ...Object.keys(verifiedByType),
    ]);

    const coverage = Array.from(allTypes)
      .map((recordType) => {
        const total = totalsByType[recordType] ?? 0;
        const verified = verifiedByType[recordType] ?? 0;
        const percentage =
          total > 0 ? Math.round((verified / total) * 10000) / 100 : 0;
        return { recordType, total, verified, percentage };
      })
      .sort((a, b) => a.recordType.localeCompare(b.recordType));

    return c.json({ coverage });
  })

  // ---- GET /due-for-recheck ----
  .get("/due-for-recheck", zv("query", DueForRecheckQuery), async (c) => {
    const { limit, offset, record_type, min_priority } = c.req.valid("query");
    const db = getDrizzleDb();

    // Build priority CASE expression based on verdict severity
    const priorityExpr = sql<number>`CASE ${sourceCheckVerdicts.verdict}
      WHEN 'contradicted' THEN 100
      WHEN 'outdated' THEN 80
      WHEN 'partial' THEN 50
      WHEN 'unverifiable' THEN 30
      WHEN 'confirmed' THEN 10
      ELSE 0
    END`;

    // Items are due for recheck when:
    // 1. next_check_due <= NOW(), or
    // 2. needs_recheck = true
    const dueConditions = or(
      lte(sourceCheckVerdicts.nextCheckDue, sql`NOW()`),
      eq(sourceCheckVerdicts.needsRecheck, true),
    );

    const conditions = [dueConditions];
    if (record_type) {
      conditions.push(eq(sourceCheckVerdicts.recordType, record_type));
    }

    const whereClause = and(...conditions);

    // Fetch rows with computed priority
    const rows = await db
      .select({
        recordType: sourceCheckVerdicts.recordType,
        recordId: sourceCheckVerdicts.recordId,
        fieldName: sourceCheckVerdicts.fieldName,
        entityId: sourceCheckVerdicts.entityId,
        verdict: sourceCheckVerdicts.verdict,
        confidence: sourceCheckVerdicts.confidence,
        reasoning: sourceCheckVerdicts.reasoning,
        sourcesChecked: sourceCheckVerdicts.sourcesChecked,
        needsRecheck: sourceCheckVerdicts.needsRecheck,
        nextCheckDue: sourceCheckVerdicts.nextCheckDue,
        lastComputedAt: sourceCheckVerdicts.lastComputedAt,
        createdAt: sourceCheckVerdicts.createdAt,
        updatedAt: sourceCheckVerdicts.updatedAt,
        priority: priorityExpr,
      })
      .from(sourceCheckVerdicts)
      .where(whereClause)
      .orderBy(sql`${priorityExpr} DESC`, desc(sourceCheckVerdicts.lastComputedAt))
      .limit(limit)
      .offset(offset);

    // Apply min_priority filter in-app (simpler than adding it to the SQL WHERE
    // since the CASE expression would need to be repeated)
    const filtered = min_priority !== undefined
      ? rows.filter((r) => r.priority >= min_priority)
      : rows;

    // Count total matching rows
    const countResult = await db
      .select({ count: count() })
      .from(sourceCheckVerdicts)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      items: filtered.map((r) => ({
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
        priority: r.priority,
      })),
      total,
    });
  });

// ---- Exports ----

export const sourceChecksRoute = sourceChecksApp;
export type SourceChecksRoute = typeof sourceChecksApp;
