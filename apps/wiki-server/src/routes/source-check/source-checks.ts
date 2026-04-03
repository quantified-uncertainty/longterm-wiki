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
  gte,
  ne,
  isNull,
  inArray,
  ilike,
  countDistinct,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { escapeIlike } from "../shared/utils.js";
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
  wikiPages,
} from "../../schema.js";
import {
  zv,
  parseJsonBody,
  validationError,
  invalidJsonError,
  escapeIlike,
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

/**
 * The current checker model used by the source-check pipeline.
 * Evidence rows checked with a different model are flagged as stale.
 * Update this when the pipeline switches to a newer model.
 */
export const CURRENT_CHECKER_MODEL = "claude-haiku-4-5-20251001";

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
  /** Human-readable record name, persisted at write time (survives record deletion). */
  displayName: z.string().max(500).nullable().optional(),
  /** Human-readable entity name, persisted at write time. */
  entityDisplayName: z.string().max(500).nullable().optional(),
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
  q: z.string().max(500).optional(),
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

const StaleEvidenceQuery = z.object({
  record_type: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
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

// ---- Helpers ----

/** Check if a checker model is stale (different from the current model). */
function isStaleModel(checkerModel: string | null): boolean {
  if (!checkerModel) return true; // No model recorded = stale
  return checkerModel !== CURRENT_CHECKER_MODEL;
}

/** Map an evidence DB row to the API response shape with isStale flag. */
function mapEvidenceRow(e: {
  id: number;
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  expectedValue: string | null;
  resourceId: string | null;
  sourceUrl: string | null;
  extractedValue: string | null;
  extractedQuote: string | null;
  verdict: string;
  confidence: number | null;
  isPrimarySource: boolean;
  checkerModel: string | null;
  notes: string | null;
  checkedAt: Date | null;
}) {
  return {
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
    isStale: isStaleModel(e.checkerModel),
    notes: e.notes,
    checkedAt: e.checkedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const sourceChecksApp = new Hono()

  // ---- GET /stats ----
  .get(
    "/stats",
    zv("query", z.object({ record_type: z.string().max(50).optional() })),
    async (c) => {
      const { record_type } = c.req.valid("query");
      const db = getDrizzleDb();

      const typeCondition = record_type
        ? eq(sourceCheckVerdicts.recordType, record_type)
        : undefined;

      const [statsRow] = await db
        .select({
          total: count(),
          needsRecheck: sql<number>`count(*) filter (where ${sourceCheckVerdicts.needsRecheck} = true)`,
          avgConfidence: sql<number>`coalesce(avg(${sourceCheckVerdicts.confidence}), 0)`,
        })
        .from(sourceCheckVerdicts)
        .where(typeCondition);

      const byVerdictRows = await db
        .select({
          verdict: sourceCheckVerdicts.verdict,
          count: count(),
        })
        .from(sourceCheckVerdicts)
        .where(typeCondition)
        .groupBy(sourceCheckVerdicts.verdict);

      const byVerdict: Record<string, number> = {};
      for (const row of byVerdictRows) {
        byVerdict[row.verdict] = row.count;
      }

      // by_type is always unfiltered (shows all types for the type-filter tabs)
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

      // Count stale evidence rows (checker_model != current model)
      const [staleRow] = await db
        .select({ count: count() })
        .from(sourceCheckEvidence)
        .where(
          or(
            ne(sourceCheckEvidence.checkerModel, CURRENT_CHECKER_MODEL),
            isNull(sourceCheckEvidence.checkerModel),
          )
        );

      return c.json({
        total: statsRow.total,
        by_verdict: byVerdict,
        by_type: byType,
        needs_recheck: Number(statsRow.needsRecheck),
        avg_confidence:
          Math.round(Number(statsRow.avgConfidence) * 100) / 100,
        stale_evidence_count: staleRow.count,
        current_checker_model: CURRENT_CHECKER_MODEL,
      });
    }
  )

  // ---- GET /verdicts ----
  .get("/verdicts", zv("query", VerdictsQuery), async (c) => {
    const { record_type, verdict, entity_id, needs_recheck, q, limit, offset } =
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
    if (q) {
      const pattern = `%${escapeIlike(q)}%`;
      conditions.push(
        or(
          ilike(sourceCheckVerdicts.recordId, pattern),
          ilike(sourceCheckVerdicts.recordType, pattern),
          ilike(sourceCheckVerdicts.entityId, pattern),
          ilike(sourceCheckVerdicts.reasoning, pattern),
          ilike(sourceCheckVerdicts.displayName, pattern),
          ilike(sourceCheckVerdicts.entityDisplayName, pattern),
          ilike(sourceCheckVerdicts.fieldName, pattern),
        )!
      );
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
        displayName: r.displayName,
        entityDisplayName: r.entityDisplayName,
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
    // Order by sourceUrl first (for grouping), then by checkedAt descending
    const evidenceRows = await db
      .select()
      .from(sourceCheckEvidence)
      .where(
        and(
          eq(sourceCheckEvidence.recordType, recordType),
          eq(sourceCheckEvidence.recordId, recordId),
        )
      )
      .orderBy(sourceCheckEvidence.sourceUrl, desc(sourceCheckEvidence.checkedAt))
      .limit(200);

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
      evidence: evidenceRows.map(mapEvidenceRow),
      currentCheckerModel: CURRENT_CHECKER_MODEL,
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
        return c.json({ evidence: [], currentCheckerModel: CURRENT_CHECKER_MODEL });
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
        .orderBy(sourceCheckEvidence.sourceUrl, desc(sourceCheckEvidence.checkedAt))
        .limit(limit)
        .offset(offset);

      return c.json({
        evidence: rows.map(mapEvidenceRow),
        currentCheckerModel: CURRENT_CHECKER_MODEL,
      });
    }
  )

  // ---- POST /evidence ----
  // Upserts on (recordType, recordId, sourceUrl, checkerModel) to prevent duplicates.
  // If a row with the same key exists, updates it; otherwise inserts a new row.
  .post("/evidence", async (c) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const parsed = EvidenceBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const body = parsed.data;
    const db = getDrizzleDb();
    const now = new Date();

    const sourceUrlVal = body.sourceUrl ?? null;
    const checkerModelVal = body.checkerModel ?? null;

    // Two-step upsert: try UPDATE first (matching the dedup key), INSERT if no match.
    // This pattern avoids ON CONFLICT with COALESCE expression issues.
    const sourceUrlForLookup = sourceUrlVal ?? "";
    const checkerModelForLookup = checkerModelVal ?? "";

    const updated = await db
      .update(sourceCheckEvidence)
      .set({
        fieldName: body.fieldName ?? null,
        entityId: body.entityId ?? null,
        expectedValue: body.expectedValue ?? null,
        resourceId: body.resourceId ?? null,
        extractedValue: body.extractedValue ?? null,
        extractedQuote: body.extractedQuote ?? null,
        verdict: body.verdict,
        confidence: body.confidence ?? null,
        isPrimarySource: body.isPrimarySource,
        notes: body.notes ?? null,
        checkedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(sourceCheckEvidence.recordType, body.recordType),
          eq(sourceCheckEvidence.recordId, body.recordId),
          sql`COALESCE(${sourceCheckEvidence.sourceUrl}, '') = ${sourceUrlForLookup}`,
          sql`COALESCE(${sourceCheckEvidence.checkerModel}, '') = ${checkerModelForLookup}`,
        )
      )
      .returning({ id: sourceCheckEvidence.id });

    let evidenceId: number;
    let wasUpdated: boolean;

    if (updated.length > 0) {
      evidenceId = updated[0].id;
      wasUpdated = true;
    } else {
      // No existing row found — insert a new one
      try {
        const [inserted] = await db
          .insert(sourceCheckEvidence)
          .values({
            recordType: body.recordType,
            recordId: body.recordId,
            fieldName: body.fieldName ?? null,
            entityId: body.entityId ?? null,
            expectedValue: body.expectedValue ?? null,
            resourceId: body.resourceId ?? null,
            sourceUrl: sourceUrlVal,
            extractedValue: body.extractedValue ?? null,
            extractedQuote: body.extractedQuote ?? null,
            verdict: body.verdict,
            confidence: body.confidence ?? null,
            isPrimarySource: body.isPrimarySource,
            checkerModel: checkerModelVal,
            notes: body.notes ?? null,
            checkedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: sourceCheckEvidence.id });

        evidenceId = inserted.id;
        wasUpdated = false;
      } catch (insertErr: unknown) {
        // Race condition: another request inserted between our UPDATE and INSERT.
        // Retry the UPDATE which should now find the row.
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("23505")) {
          const retried = await db
            .update(sourceCheckEvidence)
            .set({
              fieldName: body.fieldName ?? null,
              entityId: body.entityId ?? null,
              expectedValue: body.expectedValue ?? null,
              resourceId: body.resourceId ?? null,
              extractedValue: body.extractedValue ?? null,
              extractedQuote: body.extractedQuote ?? null,
              verdict: body.verdict,
              confidence: body.confidence ?? null,
              isPrimarySource: body.isPrimarySource,
              notes: body.notes ?? null,
              checkedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(sourceCheckEvidence.recordType, body.recordType),
                eq(sourceCheckEvidence.recordId, body.recordId),
                sql`COALESCE(${sourceCheckEvidence.sourceUrl}, '') = ${sourceUrlForLookup}`,
                sql`COALESCE(${sourceCheckEvidence.checkerModel}, '') = ${checkerModelForLookup}`,
              )
            )
            .returning({ id: sourceCheckEvidence.id });

          evidenceId = retried[0]?.id ?? 0;
          wasUpdated = true;
        } else {
          throw insertErr;
        }
      }
    }

    // Auto-flag corresponding verdicts for recheck
    const verdictUpdated = await db
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
        id: evidenceId,
        wasUpdated,
        verdictFlagged: verdictUpdated.length > 0,
      },
      wasUpdated ? 200 : 201
    );
  })

  // ---- GET /stale-evidence ----
  // Returns evidence rows checked with outdated models (not the current checker model).
  .get("/stale-evidence", zv("query", StaleEvidenceQuery), async (c) => {
    const { record_type, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [
      or(
        ne(sourceCheckEvidence.checkerModel, CURRENT_CHECKER_MODEL),
        isNull(sourceCheckEvidence.checkerModel),
      ),
    ];

    if (record_type) {
      conditions.push(eq(sourceCheckEvidence.recordType, record_type));
    }

    const whereClause = and(...conditions);

    const rows = await db
      .select()
      .from(sourceCheckEvidence)
      .where(whereClause)
      .orderBy(desc(sourceCheckEvidence.checkedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(sourceCheckEvidence)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      evidence: rows.map(mapEvidenceRow),
      total,
      currentCheckerModel: CURRENT_CHECKER_MODEL,
    });
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
    const displayNameVal = body.displayName ?? null;
    const entityDisplayNameVal = body.entityDisplayName ?? null;

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
        displayName: displayNameVal,
        entityDisplayName: entityDisplayNameVal,
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
            displayName: displayNameVal,
            entityDisplayName: entityDisplayNameVal,
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
              displayName: displayNameVal,
              entityDisplayName: entityDisplayNameVal,
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

    // Phase 0: Check for persisted display names in source_check_verdicts.
    // These survive record deletion and are the most reliable source.
    const storedNames = await db
      .select({
        recordId: sourceCheckVerdicts.recordId,
        displayName: sourceCheckVerdicts.displayName,
      })
      .from(sourceCheckVerdicts)
      .where(
        and(
          eq(sourceCheckVerdicts.recordType, record_type),
          inArray(sourceCheckVerdicts.recordId, record_ids),
          isNull(sourceCheckVerdicts.fieldName),
        )
      );
    for (const row of storedNames) {
      if (row.displayName) {
        names[row.recordId] = row.displayName;
      }
    }

    // Only resolve IDs that don't have a stored display name
    const remainingIds = record_ids.filter((id) => !names[id]);
    // Replace record_ids with remainingIds for type-specific resolution below
    const idsToResolve = remainingIds.length > 0 ? remainingIds : [];

    if (idsToResolve.length === 0) {
      return c.json({ names });
    }

    if (record_type === "personnel") {
      // Personnel: join with entities to get person name + org name.
      // The join uses stableId, but some records have numeric IDs (e.g. "304")
      // or wikiIds (e.g. "E304") in personEntityId instead. We handle fallbacks below.
      const personEntity = alias(entities, "person_entity");
      const orgEntity = alias(entities, "org_entity");

      const rows = await db
        .select({
          id: personnel.id,
          personDisplayName: personnel.personDisplayName,
          personId: personnel.personId,
          personEntityId: personnel.personEntityId,
          personEntityTitle: personEntity.title,
          orgDisplayName: personnel.orgDisplayName,
          orgEntityId: personnel.orgEntityId,
          orgEntityTitle: orgEntity.title,
        })
        .from(personnel)
        .leftJoin(
          personEntity,
          eq(personEntity.stableId, personnel.personEntityId)
        )
        .leftJoin(orgEntity, eq(orgEntity.stableId, personnel.orgEntityId))
        .where(inArray(personnel.id, idsToResolve));

      // Collect unresolved person/org entity IDs for secondary lookup
      const unresolvedPersonIds: string[] = [];
      const unresolvedOrgIds: string[] = [];
      for (const row of rows) {
        if (!row.personDisplayName && !row.personEntityTitle && row.personEntityId) {
          unresolvedPersonIds.push(row.personEntityId);
        }
        if (!row.orgDisplayName && !row.orgEntityTitle && row.orgEntityId) {
          unresolvedOrgIds.push(row.orgEntityId);
        }
      }

      // Secondary lookup: try matching unresolved IDs by wikiId (e.g. "E304"
      // from "304") or by slug. This handles numeric personEntityId values.
      const entityFallbackMap = new Map<string, string>();
      const allUnresolved = [...new Set([...unresolvedPersonIds, ...unresolvedOrgIds])];
      if (allUnresolved.length > 0) {
        // Build lookup candidates: try "E<id>" for purely numeric IDs,
        // and try the raw value as a slug
        const wikiIdCandidates: string[] = [];
        const slugCandidates: string[] = [];
        for (const uid of allUnresolved) {
          if (/^\d+$/.test(uid)) {
            wikiIdCandidates.push(`E${uid}`);
          }
          slugCandidates.push(uid);
        }

        if (wikiIdCandidates.length > 0 || slugCandidates.length > 0) {
          const conditions = [];
          if (wikiIdCandidates.length > 0) {
            conditions.push(inArray(entities.wikiId, wikiIdCandidates));
          }
          if (slugCandidates.length > 0) {
            conditions.push(inArray(entities.id, slugCandidates));
          }

          const fallbackRows = await db
            .select({
              stableId: entities.stableId,
              slug: entities.id,
              wikiId: entities.wikiId,
              title: entities.title,
            })
            .from(entities)
            .where(or(...conditions));

          // Map back: for each unresolved ID, check if we found a match
          for (const uid of allUnresolved) {
            const byWikiId = /^\d+$/.test(uid)
              ? fallbackRows.find((r) => r.wikiId === `E${uid}`)
              : undefined;
            const bySlug = fallbackRows.find((r) => r.slug === uid);
            const match = byWikiId ?? bySlug;
            if (match) {
              entityFallbackMap.set(uid, match.title);
            }
          }
        }
      }

      for (const row of rows) {
        // Resolve person name with fallback chain:
        // 1. personDisplayName (strip "new:" prefix if present)
        // 2. personEntityTitle (from stableId join)
        // 3. entityFallbackMap (from wikiId/slug secondary lookup)
        // 4. personId (legacy field, often a readable name)
        // 5. "Staff" as last resort
        let personName = row.personDisplayName ?? row.personEntityTitle ?? null;
        if (!personName && row.personEntityId) {
          personName = entityFallbackMap.get(row.personEntityId) ?? null;
        }
        if (!personName && row.personId) {
          // Legacy personId may be a readable name (not a hash/UUID)
          const pid = row.personId;
          if (pid.length > 2 && !/^[a-f0-9]{10}$/.test(pid) && !/^\d+$/.test(pid)) {
            personName = pid;
          }
        }
        personName = personName ?? "Staff";

        // Strip "new:" prefix — data pipeline artifact
        if (personName.startsWith("new:")) {
          personName = personName.slice(4).trim();
        }

        // Resolve org name with same fallback chain
        let orgName = row.orgDisplayName ?? row.orgEntityTitle ?? null;
        if (!orgName && row.orgEntityId) {
          orgName = entityFallbackMap.get(row.orgEntityId) ?? null;
        }

        names[row.id] = orgName ? `${personName} @ ${orgName}` : personName;
      }
    } else if (record_type === "division") {
      const rows = await db
        .select({ id: divisions.id, name: divisions.name })
        .from(divisions)
        .where(inArray(divisions.id, idsToResolve));

      for (const row of rows) {
        names[row.id] = row.name;
      }
    } else if (record_type === "fact") {
      // Resolve fact IDs to human-readable labels (e.g. "Headquarters")
      const rows = await db
        .select({ factId: facts.factId, label: facts.label })
        .from(facts)
        .where(inArray(facts.factId, idsToResolve));

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
        .where(inArray(entities.stableId, idsToResolve));

      for (const row of rows) {
        if (row.stableId && row.title) {
          names[row.stableId] = row.title;
        }
      }
    } else if (record_type === "publication") {
      const rows = await db
        .select({ id: publications.id, title: publications.title })
        .from(publications)
        .where(inArray(publications.id, idsToResolve));

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
        .where(inArray(benchmarkResults.id, idsToResolve));

      for (const row of rows) {
        const bmName = row.benchmarkName ?? "Unknown benchmark";
        const score = row.score != null ? String(row.score) : "?";
        names[row.id] = `${row.modelId} / ${bmName}: ${score}`;
      }
    } else if (record_type === "entity-event") {
      const rows = await db
        .select({ id: entityEvents.id, title: entityEvents.title })
        .from(entityEvents)
        .where(inArray(entityEvents.id, idsToResolve));

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
        .where(inArray(entityAssessments.id, idsToResolve));

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
        .where(inArray(secondaryMarketPrices.id, idsToResolve));

      for (const row of rows) {
        const company = row.companyDisplayName ?? row.companyId;
        names[row.id] = `${company} (${row.platform}) ${row.date}`;
      }
    } else if (record_type === "citation") {
      // Citation record IDs have format "page:<slug>:fn<N>".
      // Resolve to "<page title> - Footnote N".
      const slugSet = new Set<string>();
      const parsed: Array<{ recordId: string; slug: string; footnote: string }> = [];
      for (const rid of idsToResolve) {
        const match = rid.match(/^page:(.+):fn(\d+)$/);
        if (match) {
          slugSet.add(match[1]);
          parsed.push({ recordId: rid, slug: match[1], footnote: match[2] });
        } else {
          // Fallback: use the raw ID
          names[rid] = rid;
        }
      }

      if (slugSet.size > 0) {
        const slugArray = [...slugSet];
        const rows = await db
          .select({ slug: wikiPages.slug, title: wikiPages.title })
          .from(wikiPages)
          .where(inArray(wikiPages.slug, slugArray));

        const titleMap = new Map<string, string>();
        for (const row of rows) {
          titleMap.set(row.slug, row.title);
        }

        for (const p of parsed) {
          const pageTitle = titleMap.get(p.slug) ?? p.slug;
          names[p.recordId] = `${pageTitle} - Footnote ${p.footnote}`;
        }
      }
    } else if (record_type === "wiki-page") {
      // Resolve page slugs to page titles
      const rows = await db
        .select({ slug: wikiPages.slug, title: wikiPages.title })
        .from(wikiPages)
        .where(inArray(wikiPages.slug, idsToResolve));

      for (const row of rows) {
        names[row.slug] = row.title;
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
            inArray(things.sourceId, idsToResolve)
          )
        );

      for (const row of rows) {
        names[row.sourceId] = row.title;
      }
    }

    // ---- Fallback for orphaned records ----
    // Records that were deleted/re-imported after source-checking won't be found
    // by the type-specific queries above. For those, extract a display name from
    // the verdict reasoning in source_check_verdicts + the linked entity title.
    const unresolved = record_ids.filter((id) => !names[id]);
    if (unresolved.length > 0) {
      const fallbackRows = await db
        .select({
          recordId: sourceCheckVerdicts.recordId,
          entityId: sourceCheckVerdicts.entityId,
          reasoning: sourceCheckVerdicts.reasoning,
          entityTitle: entities.title,
        })
        .from(sourceCheckVerdicts)
        .leftJoin(entities, eq(entities.stableId, sourceCheckVerdicts.entityId))
        .where(
          and(
            eq(sourceCheckVerdicts.recordType, record_type),
            inArray(sourceCheckVerdicts.recordId, unresolved),
            isNull(sourceCheckVerdicts.fieldName),
          )
        );

      // If entity join failed (entityId stored without sid_ prefix), try with prefix
      const stillMissing = new Map<string, typeof fallbackRows[number]>();
      for (const row of fallbackRows) {
        if (!row.entityTitle && row.entityId) {
          stillMissing.set(row.entityId, row);
        }
      }
      const prefixedLookup = new Map<string, string>();
      if (stillMissing.size > 0) {
        const prefixedIds = [...stillMissing.keys()].map((id) =>
          id.startsWith("sid_") ? id : `sid_${id}`
        );
        const entityRows = await db
          .select({ stableId: entities.stableId, title: entities.title })
          .from(entities)
          .where(inArray(entities.stableId, prefixedIds));
        for (const row of entityRows) {
          if (row.stableId && row.title) {
            // Map bare ID → title
            const bareId = row.stableId.startsWith("sid_")
              ? row.stableId.slice(4)
              : row.stableId;
            prefixedLookup.set(bareId, row.title);
            prefixedLookup.set(row.stableId, row.title);
          }
        }
      }

      for (const row of fallbackRows) {
        if (names[row.recordId]) continue; // already resolved by dedup
        const entityName =
          row.entityTitle ??
          (row.entityId ? prefixedLookup.get(row.entityId) : null) ??
          null;

        // Try to extract a person/item name from the reasoning text
        // Common patterns: "confirms that [Name] joined..." / "The source confirms [Name]..."
        let extractedName: string | null = null;
        if (row.reasoning) {
          const nameMatch = row.reasoning.match(
            /(?:confirms?\s+(?:that\s+)?|identifies?\s+|mentions?\s+|states?\s+(?:that\s+)?)([A-Z][a-zA-Z.''-]+(?:\s+[A-Z][a-zA-Z.''-]+){0,4})/
          );
          if (nameMatch?.[1]) {
            extractedName = nameMatch[1].trim();
          }
        }

        if (extractedName && entityName) {
          names[row.recordId] = `${extractedName} @ ${entityName}`;
        } else if (extractedName) {
          names[row.recordId] = extractedName;
        } else if (entityName) {
          names[row.recordId] = `${entityName} record`;
        }
        // If nothing resolves, the ID stays unresolved (shown as raw ID by frontend)
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
      UNION ALL
      SELECT 'citation', count(*)::int FROM citation_quotes WHERE accuracy_verdict IS NOT NULL
      UNION ALL
      SELECT 'wiki-page', count(*)::int FROM wiki_pages
      UNION ALL
      SELECT 'fact', count(DISTINCT fact_id)::int FROM facts
    `);

    const totalsByType: Record<string, number> = {};
    for (const row of tableCountResult) {
      const { table_name, total } = row as { table_name: string; total: number };
      if (typeof table_name === "string" && typeof total === "number") {
        totalsByType[table_name] = total;
      }
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
    // Push min_priority into SQL so the total count and pagination are correct.
    // The CASE expression is wrapped in a subquery to avoid repeating it.
    if (min_priority !== undefined) {
      conditions.push(gte(priorityExpr, min_priority));
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

    // Count total matching rows (includes min_priority filter)
    const countResult = await db
      .select({ count: count() })
      .from(sourceCheckVerdicts)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      items: rows.map((r) => ({
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
