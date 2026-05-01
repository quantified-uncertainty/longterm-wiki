import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, asc, sql, isNotNull, lte, inArray } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import {
  facts,
  entities,
  resources,
  things,
  sourceVerdicts,
  recordSources,
  sourcingUrlSuggestions,
  claimRecordLinks,
} from "../../schema.js";
import { checkRefsExist } from "../shared/ref-check.js";
import { resolveEntityStableId } from "../shared/entity-resolution.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  dbError,
  zv,
  clampedLimit,
} from "../shared/utils.js";
import { enforceSourcing } from "../shared/sourcing-enforcement.js";
import { SyncFactsBatchSchema } from "../../api-types.js";
import { upsertThingsInTx } from "../shared/thing-sync.js";
import { writeInlineVerdicts, logSourcingCoverage } from "../tablebase/write-inline-verdicts.js";
import { logger } from "../../logger.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const EXPORT_MAX_LIMIT = 50000;
/**
 * Cap the number of `ids` echoed back in a /prune response. The endpoint has
 * to do the work in memory either way, but the response payload is unbounded
 * without this — a caller that accidentally marks tens of thousands of rows as
 * stale would otherwise get a multi-MB JSON blob.
 */
const MAX_PRUNE_RESPONSE_IDS = 1000;

/**
 * Canonical encoding for the `things.source_id` key of a fact row. Shared by
 * the /sync dual-write and the /prune cleanup so the two cannot drift —
 * without a shared helper a future change to one side would silently leak
 * orphan `things` rows past the pruner.
 */
function factThingKey(entityId: string, factId: string): string {
  return `${encodeURIComponent(entityId)}:${encodeURIComponent(factId)}`;
}

// ---- Query schemas ----

const ByEntityQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
  measure: z.string().max(100).optional(),
});

const TimeseriesQuery = z.object({
  measure: z.string().min(1).max(100),
  limit: clampedLimit(500, 100),
});

const StalenessQuery = z.object({
  olderThan: z.string().max(20).optional(), // e.g. "2025-01" — facts with asOf before this
  limit: clampedLimit(MAX_PAGE_SIZE, 50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Helpers ----

function formatFact(f: typeof facts.$inferSelect) {
  return {
    id: f.id,
    entityId: f.entityId,
    factId: f.factId,
    label: f.label,
    value: f.value,
    numeric: f.numeric,
    low: f.low,
    high: f.high,
    asOf: f.asOf,
    validEnd: f.validEnd,
    currency: f.currency,
    measure: f.measure,
    subject: f.subject,
    note: f.note,
    source: f.source,
    format: f.format,
    formatDivisor: f.formatDivisor,
    sourceQuote: f.sourceQuote,
    usdEquivalent: f.usdEquivalent,
    exchangeRate: f.exchangeRate,
    exchangeRateDate: f.exchangeRateDate,
    dollarYear: f.dollarYear,
    syncedAt: f.syncedAt,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

/**
 * True if a row's `format` declares a numeric value but the underlying
 * column(s) are NULL — i.e. the row is malformed and cannot be rendered as
 * a number/range/min without coercing NULL→0. Issue #4017.
 *
 * Used by `/by-entity` and `/timeseries` to skip malformed rows from the
 * response (matching the `/export` behavior). The PR #4020 review found that
 * the original fix only filtered in `/export`, leaving the other two routes
 * exposing the same silent-zero bug.
 */
function isMalformedNumericRow(row: typeof facts.$inferSelect): boolean {
  if (row.format === "number" || row.format === "min") {
    return row.numeric == null;
  }
  if (row.format === "range") {
    return row.low == null || row.high == null;
  }
  return false;
}

/**
 * Filter raw fact rows to exclude malformed numeric rows, logging the count.
 * Returns the filtered list. Used by routes that return raw rows to clients.
 */
function filterMalformedRows(
  rows: Array<typeof facts.$inferSelect>,
  logContext: string,
): typeof rows {
  let skipped = 0;
  const kept = rows.filter((r) => {
    if (isMalformedNumericRow(r)) {
      skipped++;
      logger.warn(
        { factId: r.factId, entityId: r.entityId, format: r.format, logContext },
        `[facts] Skipping malformed numeric row`
      );
      return false;
    }
    return true;
  });
  if (skipped > 0) {
    logger.warn(
      { skipped, total: rows.length, logContext },
      `[facts] ${logContext}: skipped ${skipped} malformed row(s)`
    );
  }
  return kept;
}

/**
 * Reconstruct a FactValue discriminated union from flat PG columns.
 *
 * Exported for testing — not part of the public API.
 *
 * Returns `null` for malformed rows (numeric formats with NULL columns) so
 * the caller can skip them from the response. Previously these were silently
 * coerced to `value: 0`, making "0 employees" indistinguishable from missing
 * data. The YAML loader never produces such rows, so when they appear in PG
 * they indicate corrupt or legacy data — see issue #4017.
 */
export function reconstructFactValue(
  row: typeof facts.$inferSelect
):
  | { type: "number"; value: number }
  | { type: "text"; value: string }
  | { type: "date"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "ref"; value: string }
  | { type: "refs"; value: string[] }
  | { type: "range"; low: number; high: number }
  | { type: "min"; value: number }
  | { type: "json"; value: unknown }
  | null {
  switch (row.format) {
    case "number":
      if (row.numeric == null) {
        logger.warn(
          { factId: row.factId, entityId: row.entityId, format: row.format },
          `[reconstructFactValue] number-format fact has NULL numeric column — skipping row`
        );
        return null;
      }
      return { type: "number" as const, value: row.numeric };
    case "text":
      return { type: "text" as const, value: row.value ?? "" };
    case "date":
      return { type: "date" as const, value: row.value ?? "" };
    case "boolean":
      return { type: "boolean" as const, value: row.value === "true" };
    case "ref":
      return { type: "ref" as const, value: row.value ?? "" };
    case "refs":
      return { type: "refs" as const, value: row.value ? row.value.split(", ") : [] };
    case "range":
      if (row.low == null || row.high == null) {
        logger.warn(
          { factId: row.factId, entityId: row.entityId, format: row.format, low: row.low, high: row.high },
          `[reconstructFactValue] range-format fact has NULL low/high column — skipping row`
        );
        return null;
      }
      return { type: "range" as const, low: row.low, high: row.high };
    case "min":
      if (row.numeric == null) {
        logger.warn(
          { factId: row.factId, entityId: row.entityId, format: row.format },
          `[reconstructFactValue] min-format fact has NULL numeric column — skipping row`
        );
        return null;
      }
      return { type: "min" as const, value: row.numeric };
    case "json":
      if (row.value == null) return { type: "json" as const, value: null };
      try {
        return { type: "json" as const, value: JSON.parse(row.value) };
      } catch {
        return { type: "text" as const, value: row.value };
      }
    default:
      // Guard: reject stale "[object Object]" artifacts from pre-March 2026 sync
      // (old data/facts/*.yaml had {min: N} objects that String() serialized as "[object Object]")
      if (row.value === "[object Object]") return { type: "text" as const, value: "" };
      // Infer type from available columns when format is null (pre-format-column facts).
      // Without this, numeric facts render as raw strings (e.g., "380000000000" instead
      // of "$380 billion") because the default path returns { type: "text" }.
      if (row.numeric != null) return { type: "number" as const, value: row.numeric };
      if (row.low != null && row.high != null) return { type: "range" as const, low: row.low, high: row.high };
      return { type: "text" as const, value: row.value ?? "" };
  }
}

/**
 * Convert a PG facts row into the KB Fact shape used by SerializedKB.
 * Omits `unit` (comes from Property) and `derivedFrom` (display-only, not stored in PG).
 *
 * Returns `null` when the underlying row is malformed (e.g. number-format fact
 * with a NULL numeric column). Callers must filter null entries from the response.
 */
function pgRowToFact(row: typeof facts.$inferSelect) {
  const value = reconstructFactValue(row);
  if (value == null) return null;
  return {
    id: row.factId,
    subjectId: row.entityId,
    propertyId: row.measure ?? "",
    value,
    ...(row.asOf != null && { asOf: row.asOf }),
    ...(row.validEnd != null && { validEnd: row.validEnd }),
    ...(row.source != null && { source: row.source }),
    ...(row.sourceQuote != null && { sourceQuote: row.sourceQuote }),
    ...(row.note != null && { notes: row.note }),
    ...(row.currency != null && { currency: row.currency }),
    ...(row.usdEquivalent != null && { usdEquivalent: row.usdEquivalent }),
    ...(row.exchangeRate != null && { exchangeRate: row.exchangeRate }),
    ...(row.exchangeRateDate != null && { exchangeRateDate: row.exchangeRateDate }),
    ...(row.dollarYear != null && { dollarYear: row.dollarYear }),
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const factsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const totalResult = await db.select({ count: count() }).from(facts);
    const total = totalResult[0].count;

    const entityCountResult = await db
      .select({
        count: sql<number>`count(distinct ${facts.entityId})`,
      })
      .from(facts);
    const uniqueEntities = Number(entityCountResult[0].count);

    const measureCountResult = await db
      .select({
        count: sql<number>`count(distinct ${facts.measure})`,
      })
      .from(facts)
      .where(isNotNull(facts.measure));
    const uniqueMeasures = Number(measureCountResult[0].count);

    return c.json({
      total,
      uniqueEntities,
      uniqueMeasures,
    });
  })

  // ---- GET /stale ----
  .get("/stale", zv("query", StalenessQuery), async (c) => {
    const { olderThan, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [isNotNull(facts.asOf)];
    if (olderThan) {
      conditions.push(lte(facts.asOf, olderThan));
    }

    const whereClause = and(...conditions);

    const rows = await db
      .select({
        entityId: facts.entityId,
        factId: facts.factId,
        label: facts.label,
        asOf: facts.asOf,
        measure: facts.measure,
        value: facts.value,
        numeric: facts.numeric,
      })
      .from(facts)
      .where(whereClause)
      .orderBy(asc(facts.asOf))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(facts)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({ facts: rows, total, limit, offset });
  })

  // ---- GET /timeseries/:entityId ----
  .get("/timeseries/:entityId", zv("query", TimeseriesQuery), async (c) => {
    const rawId = c.req.param("entityId");

    const { measure, limit } = c.req.valid("query");
    const db = getDrizzleDb();

    // Resolve slug/wikiId/stableId to stableId (facts.entity_id stores stableIds)
    const entityId = await resolveEntityStableId(db, rawId) ?? rawId;

    const rows = await db
      .select()
      .from(facts)
      .where(
        and(
          eq(facts.entityId, entityId),
          eq(facts.measure, measure),
          isNotNull(facts.asOf)
        )
      )
      .orderBy(asc(facts.asOf))
      .limit(limit);

    // Issue #4017: drop malformed numeric rows so consumers don't see
    // ghost zeros from NULL columns. The original PR only filtered in
    // `/export`; this filter was added in PR #4020 review.
    const cleanRows = filterMalformedRows(rows, "/timeseries");

    return c.json({
      entityId,
      measure,
      points: cleanRows.map(formatFact),
      total: cleanRows.length,
    });
  })

  // ---- GET /by-entity/:entityId ----
  .get("/by-entity/:entityId", zv("query", ByEntityQuery), async (c) => {
    const rawId = c.req.param("entityId");

    const { limit, offset, measure } = c.req.valid("query");
    const db = getDrizzleDb();

    // Resolve slug/wikiId/stableId to stableId (facts.entity_id stores stableIds)
    const entityId = await resolveEntityStableId(db, rawId) ?? rawId;

    const conditions = [eq(facts.entityId, entityId)];
    if (measure) conditions.push(eq(facts.measure, measure));

    const whereClause = and(...conditions);

    const rows = await db
      .select()
      .from(facts)
      .where(whereClause)
      .orderBy(asc(facts.factId))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(facts)
      .where(whereClause);
    const total = countResult[0].count;

    // Issue #4017: drop malformed numeric rows from the response. Note that
    // `total` still reflects the database total (including malformed rows) so
    // pagination consumers don't get stuck — see facts.test.ts for the
    // documented contract.
    const cleanRows = filterMalformedRows(rows, "/by-entity");

    return c.json({
      entityId,
      facts: cleanRows.map(formatFact),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /export ----
  // Returns all facts grouped by entityId, reconstructed into the KB Fact shape
  // (FactValue discriminated union). Used by build-data.mjs to read facts from
  // PG instead of YAML.
  //
  // Supports optional pagination via `limit` (max 50000) and `offset`.
  // Callers that need the full dataset should paginate using offset until the
  // returned `total` is exhausted.
  .get(
    "/export",
    zv(
      "query",
      z.object({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(EXPORT_MAX_LIMIT)
          .default(EXPORT_MAX_LIMIT),
        offset: z.coerce.number().int().min(0).default(0),
      })
    ),
    async (c) => {
      const { limit, offset } = c.req.valid("query");
      const db = getDrizzleDb();

      const rows = await db
        .select()
        .from(facts)
        .orderBy(asc(facts.entityId), asc(facts.factId))
        .limit(limit)
        .offset(offset);

      const countResult = await db.select({ count: count() }).from(facts);
      const total = countResult[0].count;

      const grouped: Record<string, object[]> = {};
      let skippedMalformed = 0;
      for (const row of rows) {
        const fact = pgRowToFact(row);
        // pgRowToFact returns null for malformed rows (e.g. format=number with
        // numeric=NULL). Skip them rather than emitting fake { value: 0 }.
        // The warning is logged inside reconstructFactValue.
        if (fact == null) {
          skippedMalformed++;
          continue;
        }
        if (!grouped[row.entityId]) grouped[row.entityId] = [];
        grouped[row.entityId].push(fact);
      }
      if (skippedMalformed > 0) {
        logger.warn(
          { skippedMalformed, totalRows: rows.length },
          `[facts/export] Skipped ${skippedMalformed} malformed fact row(s) — see warnings above`
        );
      }

      return c.json({
        facts: grouped,
        total,
        returned: rows.length - skippedMalformed,
        limit,
        offset,
        entities: Object.keys(grouped).length,
      });
    }
  )

  // ---- POST /sync ----
  // Uses manual JSON parsing to preserve the "invalid_json" error code
  // for malformed request bodies.
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncFactsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    let items = parsed.data.facts;

    // QUA-852 / QUA-729 Phase C: server-side sourcing enforcement.
    // SOURCE_CHECK_REQUIRED.fact = true → reject items without a `sourcing`
    // block. Bulk YAML re-sync uses `?forceSkipSourcing=true&reason=...` to
    // bypass with audit logging — see crux/wiki-server/sync-facts.ts.
    const enforcementError = enforceSourcing(
      c,
      "fact",
      items as Array<{ sourcing?: unknown }>,
    );
    if (enforcementError) return enforcementError;

    const db = getDrizzleDb();

    // Validate entity references — skip facts whose entities don't exist in PG
    // rather than rejecting the entire batch. This allows syncing facts for
    // entities that ARE in PG while skipping those that haven't been synced yet.
    const entityIds = [...new Set(items.map((f) => f.entityId))];
    const missingEntities = await checkRefsExist(db, entities, entities.stableId, entityIds);
    if (missingEntities.length > 0) {
      const missingSet = new Set(missingEntities);
      const skipped = items.filter((f) => missingSet.has(f.entityId));
      items = items.filter((f) => !missingSet.has(f.entityId));
      logger.warn(
        `[facts/sync] Skipping ${skipped.length} facts for ${missingEntities.length} missing entities: ${missingEntities.slice(0, 10).join(", ")}${missingEntities.length > 10 ? ` ... (+${missingEntities.length - 10} more)` : ""}`
      );
      if (items.length === 0) {
        return c.json({ upserted: 0, verdictsWritten: 0, skipped: skipped.length });
      }
    }

    // Validate subject references (optional field, also points to entities).
    // Missing subjects are nulled out rather than rejecting the entire batch,
    // since sentinel values like "industry-average" are used in YAML but
    // aren't real entities in the DB.
    const subjectIds = [
      ...new Set(items.map((f) => f.subject).filter((s): s is string => s != null)),
    ];
    let missingSubjects: string[] = [];
    if (subjectIds.length > 0) {
      missingSubjects = await checkRefsExist(db, entities, entities.stableId, subjectIds);
      if (missingSubjects.length > 0) {
        logger.warn(
          `Facts sync: nulling out ${missingSubjects.length} unresolved subject(s): ${missingSubjects.join(", ")}`
        );
        const missingSet = new Set(missingSubjects);
        for (const item of items) {
          if (item.subject && missingSet.has(item.subject)) {
            item.subject = null;
          }
        }
      }
    }

    let upserted = 0;
    let verdictsWritten = 0;

    try {
      await db.transaction(async (tx) => {
        const allVals = items.map((f) => ({
          entityId: f.entityId,
          factId: f.factId,
          label: f.label ?? null,
          value: f.value ?? null,
          numeric: f.numeric ?? null,
          low: f.low ?? null,
          high: f.high ?? null,
          asOf: f.asOf ?? null,
          validEnd: f.validEnd ?? null,
          currency: f.currency ?? null,
          measure: f.measure ?? null,
          subject: f.subject ?? null,
          note: f.note ?? null,
          source: f.source ?? null,
          format: f.format ?? null,
          formatDivisor: f.formatDivisor ?? null,
          sourceQuote: f.sourceQuote ?? null,
          usdEquivalent: f.usdEquivalent ?? null,
          exchangeRate: f.exchangeRate ?? null,
          exchangeRateDate: f.exchangeRateDate ?? null,
          dollarYear: f.dollarYear ?? null,
        }));

        await tx
          .insert(facts)
          .values(allVals)
          .onConflictDoUpdate({
            target: [facts.entityId, facts.factId],
            set: {
              label: sql`excluded.label`,
              value: sql`excluded.value`,
              numeric: sql`excluded.numeric`,
              low: sql`excluded.low`,
              high: sql`excluded.high`,
              asOf: sql`excluded.as_of`,
              validEnd: sql`excluded.valid_end`,
              currency: sql`excluded.currency`,
              measure: sql`excluded.measure`,
              subject: sql`excluded.subject`,
              note: sql`excluded.note`,
              source: sql`excluded.source`,
              format: sql`excluded.format`,
              formatDivisor: sql`excluded.format_divisor`,
              sourceQuote: sql`excluded.source_quote`,
              usdEquivalent: sql`excluded.usd_equivalent`,
              exchangeRate: sql`excluded.exchange_rate`,
              exchangeRateDate: sql`excluded.exchange_rate_date`,
              dollarYear: sql`excluded.dollar_year`,
              syncedAt: sql`now()`,
              updatedAt: sql`now()`,
            },
          });
        // QUA-507: pointer-only things dual-write. factThingKey() helper
        // introduced in the QUA-462 prune PR.
        await upsertThingsInTx(
          tx,
          items.map((f) => {
            const thingKey = factThingKey(f.entityId, f.factId);
            return {
              id: thingKey,
              thingType: "fact" as const,
              sourceTable: "facts",
              sourceId: thingKey,
              parentThingId: f.entityId,
            };
          })
        );

        // QUA-729 Phase A: persist inline sourcing verdicts. Keyed on
        // (record_type='fact', record_id=factId) to match the convention used
        // by `factbase-sourcing` and the read path. recordId is the YAML
        // factId (10-char), not the bigserial PG id, so the verdict survives
        // a full re-sync.
        const verdictRecords = items
          .filter((f) => f.sourcing != null)
          .map((f) => ({
            recordType: "fact" as const,
            recordId: f.factId,
            entityId: f.entityId,
            sourceUrl: f.source ?? null,
            sourcing: f.sourcing!,
          }));
        const verdictsResult = await writeInlineVerdicts(tx, verdictRecords);
        verdictsWritten = verdictsResult.written;

        upserted = allVals.length;
      });
    } catch (err) {
      return dbError(c, "facts sync", err, { factCount: items.length });
    }

    logSourcingCoverage("facts/sync", items.length, verdictsWritten);

    return c.json({ upserted, verdictsWritten });
  })

  // ---- POST /prune ----
  // Remove stale facts from PG that are no longer in the YAML source.
  //
  // The caller (sync-facts.ts) sends `entries`: the full set of facts it owns
  // for each entityId. The endpoint deletes any fact in PG whose `entityId` is
  // present in the request but whose `factId` is NOT in the keep list for that
  // entity. Facts for entityIds not in the request are never touched, so
  // partial syncs cannot cause cross-entity data loss.
  //
  // Empty `factIds` for an entry means "this entity has no facts" — all of its
  // facts in PG are deleted (the constellation case from QUA-462). The dual-
  // write `things` rows for deleted facts are cleaned up in the same
  // transaction.
  .post(
    "/prune",
    zv(
      "json",
      z.object({
        entries: z
          .array(
            z.object({
              entityId: z.string().min(1).max(500),
              factIds: z.array(z.string().min(1).max(200)).max(2000),
            }),
          )
          .max(5000),
      }),
    ),
    async (c) => {
      const { entries } = c.req.valid("json");
      if (entries.length === 0) {
        return c.json({ deleted: 0, ids: [], truncated: false });
      }

      const db = getDrizzleDb();

      const entityIds = [...new Set(entries.map((e) => e.entityId))];
      const keepSet = new Set<string>();
      for (const entry of entries) {
        for (const factId of entry.factIds) {
          keepSet.add(`${entry.entityId}\u0000${factId}`);
        }
      }

      try {
        // Both the SELECT and the cascading DELETEs run inside one transaction
        // so concurrent writers see a consistent snapshot. In practice
        // sync-facts is the only writer in the deploy pipeline, but the
        // transactional read is cheap and prevents TOCTOU edge cases.
        //
        // QUA-930 cascade: when a fact is deleted, also drop its dependent
        // source_check_verdicts / source_check_evidence /
        // sourcing_url_suggestions rows (record_type='fact', record_id=fact_id).
        // Without this the /sourcing/coverage-matrix totals stay inflated by
        // orphan verdicts forever (505 → 1092 between 2026-04 ticket filing
        // and 2026-04-30).
        const result = await db.transaction(async (tx) => {
          const currentRows = await tx
            .select({
              id: facts.id,
              entityId: facts.entityId,
              factId: facts.factId,
            })
            .from(facts)
            .where(inArray(facts.entityId, entityIds));

          const staleRows = currentRows.filter(
            (r) => !keepSet.has(`${r.entityId}\u0000${r.factId}`),
          );

          if (staleRows.length === 0) {
            return {
              staleRows,
              cascadedVerdicts: 0,
              cascadedEvidence: 0,
              cascadedSuggestions: 0,
              cascadedClaimLinks: 0,
            };
          }

          const staleRowIds = staleRows.map((r) => r.id);
          const staleFactIds = staleRows.map((r) => r.factId);
          const staleThingIds = staleRows.map((r) =>
            factThingKey(r.entityId, r.factId),
          );

          // Clean up the dual-write things rows first (no FK from things →
          // facts, but ordering is consistent with the entities prune).
          await tx
            .delete(things)
            .where(
              and(
                eq(things.sourceTable, "facts"),
                inArray(things.sourceId, staleThingIds),
              ),
            );

          // QUA-930 cascade: drop dependent sourcing rows. record_id for
          // fact-typed rows stores fact_id (not the serial PK) — see
          // LIVE_RECORDS_CTE in the sourcing route. Done before the facts
          // DELETE so any future FK from these tables → facts.fact_id would
          // not block the delete; today there is no FK so order is
          // semantic-only but deliberate.
          const verdictRows = await tx
            .delete(sourceVerdicts)
            .where(
              and(
                eq(sourceVerdicts.recordType, "fact"),
                inArray(sourceVerdicts.recordId, staleFactIds),
              ),
            )
            .returning({ recordId: sourceVerdicts.recordId });
          const evidenceRows = await tx
            .delete(recordSources)
            .where(
              and(
                eq(recordSources.recordType, "fact"),
                inArray(recordSources.recordId, staleFactIds),
              ),
            )
            .returning({ recordId: recordSources.recordId });
          const suggestionRows = await tx
            .delete(sourcingUrlSuggestions)
            .where(
              and(
                eq(sourcingUrlSuggestions.recordType, "fact"),
                inArray(sourcingUrlSuggestions.recordId, staleFactIds),
              ),
            )
            .returning({ recordId: sourcingUrlSuggestions.recordId });
          // claim_record_links uses the same (record_type, record_id) pattern.
          // It is NOT cleaned up by /api/sourcing/cleanup-orphans (which only
          // covers verdicts/evidence/suggestions), so without this cascade
          // deleted facts leak link rows that point at non-existent claim
          // verifications. Same class of bug as the rest of the cascade.
          const claimLinkRows = await tx
            .delete(claimRecordLinks)
            .where(
              and(
                eq(claimRecordLinks.recordType, "fact"),
                inArray(claimRecordLinks.recordId, staleFactIds),
              ),
            )
            .returning({ recordId: claimRecordLinks.recordId });

          await tx.delete(facts).where(inArray(facts.id, staleRowIds));

          return {
            staleRows,
            cascadedVerdicts: verdictRows.length,
            cascadedEvidence: evidenceRows.length,
            cascadedSuggestions: suggestionRows.length,
            cascadedClaimLinks: claimLinkRows.length,
          };
        });

        const {
          staleRows: stale,
          cascadedVerdicts,
          cascadedEvidence,
          cascadedSuggestions,
          cascadedClaimLinks,
        } = result;

        if (stale.length === 0) {
          return c.json({
            deleted: 0,
            ids: [],
            truncated: false,
            cascaded: {
              verdicts: 0,
              evidence: 0,
              suggestions: 0,
              claimLinks: 0,
            },
          });
        }

        // Log AFTER commit (a pre-commit log lies if the transaction aborts).
        // We include up to 100 sample IDs rather than 10 — deletion is
        // destructive and the audit log is the primary post-hoc forensics
        // source.
        logger.info(
          {
            count: stale.length,
            entities: entityIds.length,
            cascadedVerdicts,
            cascadedEvidence,
            cascadedSuggestions,
            cascadedClaimLinks,
            sample: stale
              .slice(0, 100)
              .map((r) => `${r.entityId}/${r.factId}`),
          },
          `Pruned ${stale.length} stale facts across ${entityIds.length} entities` +
            ` (cascaded ${cascadedVerdicts} verdicts, ${cascadedEvidence} evidence, ${cascadedSuggestions} suggestions, ${cascadedClaimLinks} claim links)`,
        );

        // Cap the response payload. The server already paid the cost of
        // holding the full stale list in memory, but echoing 50k+ IDs back
        // over HTTP is pointless — the client only uses `deleted` (count) and
        // the first few IDs for logging.
        const truncated = stale.length > MAX_PRUNE_RESPONSE_IDS;
        const ids = stale
          .slice(0, MAX_PRUNE_RESPONSE_IDS)
          .map((r) => ({ entityId: r.entityId, factId: r.factId }));

        return c.json({
          deleted: stale.length,
          ids,
          truncated,
          cascaded: {
            verdicts: cascadedVerdicts,
            evidence: cascadedEvidence,
            suggestions: cascadedSuggestions,
            claimLinks: cascadedClaimLinks,
          },
        });
      } catch (err) {
        return dbError(c, "facts prune", err, { entityCount: entityIds.length });
      }
    },
  );
  // NOTE: Duplicate /export route was removed here. The active /export route is
  // defined above (uses pgRowToFact). See #3173.

// ---- Exports ----

/**
 * Facts route handler — mount at `/api/facts` in the main app.
 *
 * Also exports `FactsRoute` type for Hono RPC client type inference.
 * Clients import this type and use `hc<FactsRoute>(baseUrl)` to get
 * compile-time type-safe API calls with inferred request/response types.
 */
export const factsRoute = factsApp;
export type FactsRoute = typeof factsApp;
