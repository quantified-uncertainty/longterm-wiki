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
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import {
  recordSources,
  sourceVerdicts,
  personnel,
  entities,
  divisions,
  things,
  thingsSearch,
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
  clampedLimit,
  parseJsonBody,
  validationError,
  invalidJsonError,
  escapeIlike,
  qBool,
} from "../shared/utils.js";
import {
  SOURCING_EXEMPT_TYPES,
  isSourcingExempt,
} from "../../api-types.js";
import { getNonVerifiablePropertyIds } from "../../property-metadata.js";
import { coerceDisplayName } from "../shared/display-name-coerce.js";
import {
  recomputeVerdict,
  recomputeVerdictBestEffort,
} from "./recompute-verdict.js";
import {
  aggregateEvidence,
  type AggregationResult,
  type EvidenceRow,
} from "./sourcing-aggregation.js";
import { CURRENT_CHECKER_MODEL, isStaleModel } from "./checker-model.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const MAX_ID_LENGTH = 500;
const MAX_URL_LENGTH = 2048;

/**
 * QUA-313: cooldown interval for the auto-flag path at POST /evidence.
 * Skip setting `needs_recheck=true` on a verdict whose `updated_at` is
 * newer than (now - AUTO_FLAG_COOLDOWN_MS). Matches the client-side
 * `--min-age=7d` default in `crux sourcing-mark`.
 */
export const AUTO_FLAG_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Pure helper: given a verdict row's `updated_at`, a reference `now`, and
 * the cooldown window, return true if the auto-flag path should skip it.
 * Extracted for unit testing — the handler itself uses Drizzle's
 * `lt(updated_at, cutoff)` which is equivalent.
 */
export function shouldSkipAutoFlag(
  updatedAt: Date | null,
  now: Date,
  cooldownMs: number = AUTO_FLAG_COOLDOWN_MS,
): boolean {
  if (updatedAt == null) return false;
  return now.getTime() - updatedAt.getTime() < cooldownMs;
}

const VALID_VERDICTS = [
  "confirmed",
  "contradicted",
  "unverifiable",
  "outdated",
  "partial",
  // QUA-426: pre-LLM relevance-gate short-circuit. See api-types.ts for semantics.
  "not_applicable",
] as const;

const VALID_VERDICT_TYPES = [...VALID_VERDICTS, "unchecked"] as const;

export const DEAD_LINK_CHECKER_MODEL = "dead-link-detector";

// ---- Coverage helpers (QUA-928) ----

/**
 * Round to one decimal place. Returns 0 for zero/negative denominators
 * (avoids NaN / Infinity in JSON output).
 */
function pct1(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Compute the three QUA-928 coverage percentages from a (total, checkable,
 * checked) triple. Centralised so `/coverage` and `/coverage-matrix` cannot
 * silently diverge — same field names, same definitions on both endpoints.
 *
 * Numerators are clamped so the percentages can never exceed 100% even if
 * the three counts are inconsistent (e.g. a fact was deleted between the
 * `count(facts)` and the verdict-count queries, or a property was flipped
 * from `verifiable: true` to `verifiable: false` after verdicts were
 * already written for it). The three queries are not transaction-wrapped,
 * so this clamp is the cheap defence against the resulting >100% noise.
 */
function coveragePercents(
  totalRecords: number,
  checkableRecords: number,
  checkedRecords: number,
): {
  checkabilityPercent: number;
  checkableCoveragePercent: number;
  fullCoveragePercent: number;
} {
  const checkable = Math.min(checkableRecords, totalRecords);
  const checked = Math.min(checkedRecords, checkable);
  return {
    checkabilityPercent: pct1(checkable, totalRecords),
    checkableCoveragePercent: pct1(checked, checkable),
    fullCoveragePercent: pct1(checked, totalRecords),
  };
}

/**
 * Count facts that are eligible for sourcing verification. Mirrors the inclusion
 * logic in `crux/lib/sourcing/item-collectors.ts::collectFactItems`:
 * facts must carry a source URL AND their property must not be flagged
 * `verifiable: false` in properties.yaml.
 */
async function countCheckableFacts(
  db: ReturnType<typeof getDrizzleDb>,
): Promise<number> {
  const nonVerifiable = [...getNonVerifiablePropertyIds()];
  // `sql.param(arr)` binds the JS array as a single `text[]` parameter.
  // Drizzle's `sql` template tag (used here via `db.execute(sql`...`)`)
  // would otherwise expand `${nonVerifiable}` into a row constructor
  // `($1, $2, ..., $N)` which Postgres can't cast to `text[]` and which
  // 500'd both /coverage and /coverage-matrix on prod (QUA-985). The
  // postgres-js raw tagged template (`getDb()` callsites) handles JS
  // arrays natively and does NOT need this wrapper — see
  // `routes/shared/query-helpers.ts` for the canonical write-up.
  const rows = (await db.execute(sql`
    SELECT count(DISTINCT fact_id)::int AS checkable
    FROM facts
    WHERE source IS NOT NULL AND source <> ''
      AND (measure IS NULL OR NOT (measure = ANY(${sql.param(nonVerifiable)}::text[])))
  `)) as Array<{ checkable: number | null }>;
  return rows[0]?.checkable ?? 0;
}

/**
 * For a given recordType, return the number of records that are eligible for
 * sourcing. Currently only the `fact` recordType has per-record
 * exclusion criteria; everything else is treated as fully checkable.
 */
function checkableCountFor(
  recordType: string,
  totalRecords: number,
  checkableFacts: number,
): number {
  if (recordType === "fact") return Math.min(checkableFacts, totalRecords);
  return totalRecords;
}

// ---- Shared CTE ----

/**
 * CTE listing every (record_type, record_id) pair currently present in its
 * source table. Used to filter orphan verdicts — rows in source_verdicts
 * that reference records which have since been deleted from their source
 * table. `INNER JOIN` against this CTE excludes orphans.
 *
 * `citation` rows only count when they still carry an accuracy verdict;
 * `fact` uses fact_id (not the serial PK) because source_verdicts.record_id
 * stores the fact_id for facts.
 */
const LIVE_RECORDS_CTE = sql`
  live_records AS (
    SELECT 'personnel' AS record_type, id::text AS record_id FROM personnel
    UNION ALL SELECT 'division', id::text FROM divisions
    UNION ALL SELECT 'grant', id::text FROM grants
    UNION ALL SELECT 'funding-round', id::text FROM funding_rounds
    UNION ALL SELECT 'investment', id::text FROM investments
    UNION ALL SELECT 'funding-program', id::text FROM funding_programs
    UNION ALL SELECT 'publication', id::text FROM publications
    UNION ALL SELECT 'secondary-market-price', id::text FROM secondary_market_prices
    UNION ALL SELECT 'equity-position', id::text FROM equity_positions
    UNION ALL SELECT 'entity-event', id::text FROM entity_events
    UNION ALL SELECT 'entity-assessment', id::text FROM entity_assessments
    UNION ALL SELECT 'benchmark-result', id::text FROM benchmark_results
    UNION ALL SELECT 'policy-stakeholder', id::text FROM policy_stakeholders
    UNION ALL SELECT 'citation', id::text FROM citation_quotes WHERE accuracy_verdict IS NOT NULL
    UNION ALL SELECT 'wiki-page', id::text FROM wiki_pages
    UNION ALL SELECT 'fact', fact_id FROM facts
    UNION ALL SELECT 'scorecard_grade', id::text FROM scorecard_grades
  )
`;

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
  /**
   * QUA-791: relevance weight for verdict aggregation. NULL means "not
   * supplied"; the aggregator treats it as full weight (1.0). Populated
   * by the QUA-426 relevance gate when present.
   */
  relevanceScore: z.number().min(0).max(1).nullable().optional(),
  isPrimarySource: z.boolean().default(false),
  checkerModel: z.string().max(100).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

/**
 * QUA-791 Phase 1: server-side verdict recomputation.
 *
 * Reads all evidence rows for the (recordType, recordId, fieldName) key,
 * applies the canonical aggregation rule, upserts source_check_verdicts.
 * Replaces the last-writer-wins behavior of POST /verdicts.
 */
const VerdictRecomputeBody = z.object({
  recordType: z.string().min(1).max(50),
  recordId: z.string().min(1).max(MAX_ID_LENGTH),
  fieldName: z.string().max(200).nullable().optional(),
  entityId: z.string().max(200).nullable().optional(),
  /** Persisted into source_check_verdicts.display_name. */
  displayName: z.string().max(500).nullable().optional(),
  entityDisplayName: z.string().max(500).nullable().optional(),
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
  /**
   * When true, mark this verdict as needing a recheck (e.g., because the
   * operator is queuing targeted rechecks via `crux sourcing-mark`).
   * Defaults to false — the normal write path clears the flag after a
   * successful verdict computation, matching pre-QUA-313 behavior.
   */
  needsRecheck: z.boolean().optional(),
});

/** Limit field that clamps to MAX_PAGE_SIZE instead of rejecting */
const defaultClampedLimit = clampedLimit(MAX_PAGE_SIZE, 50);

const VerdictsQuery = z.object({
  record_type: z.string().max(50).optional(),
  verdict: z.string().max(50).optional(),
  entity_id: z.string().max(200).optional(),
  needs_recheck: qBool.optional(),
  q: z.string().max(500).optional(),
  /**
   * QUA-661: when true, only return rows where `display_name` or
   * `entity_display_name` is a raw `sid_`-prefixed stableId. Used by
   * `validate-sid-display` to avoid paginating all ~14k verdict rows
   * on every gate run.
   */
  display_name_is_sid: qBool.optional(),
  limit: defaultClampedLimit,
  offset: z.coerce.number().int().min(0).default(0),
});

const EvidenceQuery = z.object({
  limit: defaultClampedLimit,
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * QUA-331: batch evidence lookup. Avoids N+1 HTTP calls when callers need
 * evidence for many records at once (e.g. `crux sourcing-suggest-urls`,
 * `sourcing-audit-urls`, `sourcing-recheck`). Grouped by recordType on the
 * server so each type resolves to one `IN (...)` query.
 */
const MAX_EVIDENCE_BY_RECORDS = 1000;
const EvidenceByRecordsBody = z.object({
  records: z
    .array(
      z.object({
        recordType: z.string().min(1).max(50),
        recordId: z.string().min(1).max(MAX_ID_LENGTH),
      })
    )
    .min(1)
    .max(MAX_EVIDENCE_BY_RECORDS),
  /**
   * Required per-record row cap. Callers must be explicit about payload
   * size — an unbounded fetch across 1000 records could load millions of
   * evidence rows into memory. A small value (e.g. 5) is sufficient for
   * "find the first non-null source URL" use cases.
   */
  limitPerRecord: z.number().int().min(1).max(MAX_PAGE_SIZE),
});

/** Must match `evidenceRecordKey` in crux/lib/wiki-server/sourcing-client.ts. */
function evidenceRecordKey(recordType: string, recordId: string): string {
  return `${recordType}|${recordId}`;
}

const DueForRecheckQuery = z.object({
  limit: defaultClampedLimit,
  offset: z.coerce.number().int().min(0).default(0),
  record_type: z.string().max(50).optional(),
  min_priority: z.coerce.number().optional(),
});

const StaleEvidenceQuery = z.object({
  record_type: z.string().max(50).optional(),
  limit: defaultClampedLimit,
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

const ByEntityQuery = z.object({
  limit: defaultClampedLimit,
  offset: z.coerce.number().int().min(0).default(0),
  verdict: z.string().max(50).optional(),
});

const ByPageQuery = z.object({
  limit: defaultClampedLimit,
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * QUA-149: cleanup-orphans request body.
 *
 * `dryRun` (default true) reports how many rows *would* be deleted without
 * touching the database. Callers must pass `dryRun: false` explicitly to
 * perform the actual delete — this avoids accidental destructive calls.
 *
 * `recordType` optionally scopes cleanup to a single type (e.g., "personnel").
 * If omitted, all known record types in LIVE_RECORDS_CTE are considered.
 * Unknown record types (not in the CTE) are always left alone, even when
 * `dryRun: false`, because we have no live-records source for them and
 * can't tell whether they're orphaned or not.
 */
const CleanupOrphansBody = z.object({
  dryRun: z.boolean().default(true),
  // Empty string would silently match no rows; reject it to force callers
  // to omit the field when they want to scan every type.
  recordType: z.string().min(1).max(50).optional(),
});

const VALID_ERROR_TYPES = [
  "contradicted",
  "outdated",
  "unverifiable",
  "partial",
] as const;

const FailuresQuery = z.object({
  error_type: z.string().max(50).optional(),
  record_type: z.string().max(50).optional(),
  entity_id: z.string().max(200).optional(),
  limit: defaultClampedLimit,
  offset: z.coerce.number().int().min(0).default(0),
});

const StaleQuery = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(90),
  record_type: z.string().max(50).optional(),
  entity_id: z.string().max(200).optional(),
  limit: defaultClampedLimit,
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Helpers ----

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
  relevanceScore: number | null;
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
    relevanceScore: e.relevanceScore,
    isPrimarySource: e.isPrimarySource,
    checkerModel: e.checkerModel,
    isStale: isStaleModel(e.checkerModel),
    notes: e.notes,
    checkedAt: e.checkedAt,
  };
}

/** Map a verdict DB row to the API response shape. */
function mapVerdictRow(r: {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  displayName: string | null;
  entityDisplayName: string | null;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sourcesChecked: number;
  needsRecheck: boolean;
  nextCheckDue: Date | null;
  lastComputedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
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
  };
}

/** Helper for /by-page endpoint: query verdicts by entity stableId and return the data. */
async function queryVerdictsByEntity(
  db: ReturnType<typeof getDrizzleDb>,
  entityId: string,
  pageTitle: string,
  limit: number,
  offset: number,
) {
  const rows = await db
    .select()
    .from(sourceVerdicts)
    .where(eq(sourceVerdicts.entityId, entityId))
    .orderBy(desc(sourceVerdicts.lastComputedAt))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: count() })
    .from(sourceVerdicts)
    .where(eq(sourceVerdicts.entityId, entityId));
  const total = countResult[0].count;

  const countsByVerdictRows = await db
    .select({
      verdict: sourceVerdicts.verdict,
      count: count(),
    })
    .from(sourceVerdicts)
    .where(eq(sourceVerdicts.entityId, entityId))
    .groupBy(sourceVerdicts.verdict);

  const counts: Record<string, number> = {
    confirmed: 0,
    contradicted: 0,
    outdated: 0,
    partial: 0,
    unverifiable: 0,
    unchecked: 0,
  };
  for (const row of countsByVerdictRows) {
    counts[row.verdict] = row.count;
  }

  return {
    verdicts: rows.map(mapVerdictRow),
    total,
    counts,
    pageTitle,
    entityId,
  };
}

// ---- Claim provenance helper ----

async function fetchClaimProvenance(
  db: ReturnType<typeof getDrizzleDb>,
  recordType: string,
  recordId: string,
) {
  const rows = (await db.execute(
    sql`SELECT pc.id::int, pc.claim_text, pc.status, pc.verdict_confidence,
               pc.source_url, pc.checker_model, pc.verified_at
        FROM claim_record_links crl
        JOIN proposed_claims pc ON pc.id = crl.claim_id
        WHERE crl.record_type = ${recordType} AND crl.record_id = ${recordId}
        ORDER BY pc.verified_at DESC NULLS LAST
        LIMIT 50`
  )) as Array<{ id: number; claim_text: string; status: string; verdict_confidence: number | null; source_url: string; checker_model: string | null; verified_at: string | null }>;

  return rows.map((r) => ({
    id: r.id,
    claimText: r.claim_text,
    status: r.status,
    confidence: r.verdict_confidence,
    sourceUrl: r.source_url,
    checkerModel: r.checker_model,
    verifiedAt: r.verified_at,
  }));
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const sourcingApp = new Hono()

  // ---- GET /stats ----
  .get(
    "/stats",
    zv("query", z.object({ record_type: z.string().max(50).optional() })),
    async (c) => {
      const { record_type } = c.req.valid("query");
      const db = getDrizzleDb();

      // All verdict aggregations filter orphan verdicts (rows referencing records
      // that have been deleted from their source table) via LIVE_RECORDS_CTE, to
      // stay consistent with /coverage-matrix and /verdict-matrix. Without this
      // filter the dashboard over-reports contradicted/partial/etc. counts by
      // including verdicts for records that no longer exist.
      const typeFilterSql = record_type
        ? sql`AND v.record_type = ${record_type}`
        : sql``;

      // count(*) with no GROUP BY always returns exactly one row, so statsRow
      // is non-null in practice. The ?? 0 fallbacks guard against a defensive
      // ceiling in the response contract.
      const statsRows = await db.execute<{
        total: number;
        needs_recheck: number;
        avg_confidence: number;
      }>(sql`
        WITH ${LIVE_RECORDS_CTE}
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE v.needs_recheck = true)::int AS needs_recheck,
          coalesce(avg(v.confidence), 0)::float AS avg_confidence
        FROM source_check_verdicts v
        INNER JOIN live_records lr
          ON lr.record_type = v.record_type AND lr.record_id = v.record_id
        WHERE 1=1 ${typeFilterSql}
      `);
      const statsRow = statsRows[0];

      const byVerdictRows = await db.execute<{ verdict: string; cnt: number }>(sql`
        WITH ${LIVE_RECORDS_CTE}
        SELECT v.verdict, count(*)::int AS cnt
        FROM source_check_verdicts v
        INNER JOIN live_records lr
          ON lr.record_type = v.record_type AND lr.record_id = v.record_id
        WHERE 1=1 ${typeFilterSql}
        GROUP BY v.verdict
      `);

      const byVerdict: Record<string, number> = {};
      for (const row of byVerdictRows) {
        byVerdict[row.verdict] = row.cnt;
      }

      // by_type is always unfiltered by record_type (shows all types for the
      // type-filter tabs) but still excludes orphans.
      const byTypeRows = await db.execute<{ record_type: string; cnt: number }>(sql`
        WITH ${LIVE_RECORDS_CTE}
        SELECT v.record_type, count(*)::int AS cnt
        FROM source_check_verdicts v
        INNER JOIN live_records lr
          ON lr.record_type = v.record_type AND lr.record_id = v.record_id
        GROUP BY v.record_type
      `);

      const byType: Record<string, number> = {};
      for (const row of byTypeRows) {
        byType[row.record_type] = row.cnt;
      }

      const [evidenceStats] = await db
        .select({
          staleCount: sql<number>`count(*) filter (where ${recordSources.checkerModel} != ${CURRENT_CHECKER_MODEL} or ${recordSources.checkerModel} is null)`,
          deadLinkCount: sql<number>`count(*) filter (where ${recordSources.checkerModel} = ${DEAD_LINK_CHECKER_MODEL}${record_type ? sql` and ${recordSources.recordType} = ${record_type}` : sql``})`,
        })
        .from(recordSources);

      return c.json({
        total: Number(statsRow?.total ?? 0),
        by_verdict: byVerdict,
        by_type: byType,
        needs_recheck: Number(statsRow?.needs_recheck ?? 0),
        avg_confidence:
          Math.round(Number(statsRow?.avg_confidence ?? 0) * 100) / 100,
        stale_evidence_count: Number(evidenceStats.staleCount),
        dead_link_count: Number(evidenceStats.deadLinkCount),
        current_checker_model: CURRENT_CHECKER_MODEL,
        exempt_types: [...SOURCING_EXEMPT_TYPES],
      });
    }
  )

  // ---- GET /verdicts ----
  .get("/verdicts", zv("query", VerdictsQuery), async (c) => {
    const { record_type, verdict, entity_id, needs_recheck, q, display_name_is_sid, limit, offset } =
      c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (record_type) {
      conditions.push(eq(sourceVerdicts.recordType, record_type));
    }
    if (verdict) {
      conditions.push(eq(sourceVerdicts.verdict, verdict));
    }
    if (needs_recheck !== undefined) {
      conditions.push(eq(sourceVerdicts.needsRecheck, needs_recheck));
    }
    if (entity_id) {
      conditions.push(eq(sourceVerdicts.entityId, entity_id));
    }
    if (display_name_is_sid) {
      // Matches the isSid() contract (prefix-only). Used by validate-sid-display
      // (QUA-661) so the gate check doesn't scan all rows just to find zero leaks.
      conditions.push(
        sql`(starts_with(${sourceVerdicts.displayName}, 'sid_') OR starts_with(${sourceVerdicts.entityDisplayName}, 'sid_'))`
      );
    }
    if (q) {
      const pattern = `%${escapeIlike(q)}%`;
      conditions.push(
        or(
          ilike(sourceVerdicts.recordId, pattern),
          ilike(sourceVerdicts.recordType, pattern),
          ilike(sourceVerdicts.entityId, pattern),
          ilike(sourceVerdicts.reasoning, pattern),
          ilike(sourceVerdicts.displayName, pattern),
          ilike(sourceVerdicts.entityDisplayName, pattern),
          ilike(sourceVerdicts.fieldName, pattern),
        )!
      );
    }

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(sourceVerdicts)
      .where(whereClause)
      .orderBy(desc(sourceVerdicts.lastComputedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(sourceVerdicts)
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
      .from(sourceVerdicts)
      .where(
        and(
          eq(sourceVerdicts.recordType, recordType),
          eq(sourceVerdicts.recordId, recordId),
        )
      );

    if (verdictRows.length === 0) {
      return c.json({ error: "not_found", message: "Verdict not found" }, 404);
    }

    // QUA-792: pull the complete evidence set in one unbounded query so the
    // aggregation matches what `recomputeVerdict` saw on write. The display
    // payload caps at 200 rows in JS — fetching twice would double the
    // index scan with no benefit.
    const [allEvidence, claimProvenance] = await Promise.all([
      db
        .select()
        .from(recordSources)
        .where(
          and(
            eq(recordSources.recordType, recordType),
            eq(recordSources.recordId, recordId),
          )
        ),
      fetchClaimProvenance(db, recordType, recordId),
    ]);

    // Re-run the canonical aggregation on read so the detail page renders
    // the headline verdict and the disagree-explainer from the same
    // `AggregationResult`. Keyed by `fieldName ?? ""` to mirror the
    // `COALESCE(field_name, '')` key used by recomputeVerdict on write.
    const verdictAggregations: Record<string, AggregationResult> = {};
    const evidenceByFieldKey = new Map<string, EvidenceRow[]>();
    for (const e of allEvidence) {
      const key = e.fieldName ?? "";
      let bucket = evidenceByFieldKey.get(key);
      if (!bucket) {
        bucket = [];
        evidenceByFieldKey.set(key, bucket);
      }
      bucket.push({
        verdict: e.verdict as EvidenceRow["verdict"],
        relevanceScore: e.relevanceScore,
        confidence: e.confidence,
        // QUA-992: aggregation tie-breaker prefers the bucket whose latest
        // evidence is most recent.
        checkedAt: e.checkedAt,
        // QUA-991: drop stale rows from the headline when a fresh row exists,
        // so the read-side aggregation on the detail page matches the write
        // side recomputeVerdict's aggregation.
        isStale: isStaleModel(e.checkerModel),
      });
    }
    for (const [key, rows] of evidenceByFieldKey) {
      verdictAggregations[key] = aggregateEvidence(rows);
    }

    // Mirror the original ORDER BY (sourceUrl ASC, checkedAt DESC) + LIMIT 200
    // for the display payload — done in JS to avoid a second SQL round trip.
    const evidenceRows = [...allEvidence]
      .sort((a, b) => {
        const su = (a.sourceUrl ?? "").localeCompare(b.sourceUrl ?? "");
        if (su !== 0) return su;
        const at = a.checkedAt?.getTime() ?? 0;
        const bt = b.checkedAt?.getTime() ?? 0;
        return bt - at;
      })
      .slice(0, 200);

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
      verdictAggregations,
      claimProvenance,
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
        .from(recordSources)
        .where(
          and(
            eq(recordSources.recordType, recordType),
            eq(recordSources.recordId, recordId),
          )
        )
        .orderBy(recordSources.sourceUrl, desc(recordSources.checkedAt))
        .limit(limit)
        .offset(offset);

      const claimProvenance = await fetchClaimProvenance(db, recordType, recordId);

      return c.json({
        evidence: rows.map(mapEvidenceRow),
        claimProvenance,
        currentCheckerModel: CURRENT_CHECKER_MODEL,
      });
    }
  )

  // ---- POST /evidence/by-records ----
  // QUA-331: batch evidence lookup. Replaces N+1 calls to
  // `GET /evidence/:recordType/:recordId` in sourcing-suggest-urls,
  // sourcing-audit-urls, and sourcing-recheck. Groups requested records by
  // recordType and issues one `IN (...)` query per type (usually 1–2 total).
  // Does NOT return `claimProvenance` — the per-record subquery would
  // defeat the purpose of batching, and no caller needs it here.
  .post("/evidence/by-records", async (c) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const parsed = EvidenceByRecordsBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);
    const { records, limitPerRecord } = parsed.data;

    // Group by recordType so each type resolves to a single IN query.
    // Deduplicate recordIds per type — callers may pass duplicates.
    const byType = new Map<string, Set<string>>();
    for (const r of records) {
      let set = byType.get(r.recordType);
      if (!set) {
        set = new Set<string>();
        byType.set(r.recordType, set);
      }
      set.add(r.recordId);
    }

    const db = getDrizzleDb();

    const evidenceByKey: Record<string, ReturnType<typeof mapEvidenceRow>[]> = {};
    for (const [recordType, idSet] of byType) {
      const rows = await db
        .select()
        .from(recordSources)
        .where(
          and(
            eq(recordSources.recordType, recordType),
            inArray(recordSources.recordId, [...idSet]),
          )
        )
        .orderBy(recordSources.sourceUrl, desc(recordSources.checkedAt));

      // Bucket by recordId and cap per record (in app, not SQL, since the
      // cap is per (recordType, recordId) and LIMIT applies to the whole
      // result set).
      for (const row of rows) {
        const key = evidenceRecordKey(row.recordType, row.recordId);
        let bucket = evidenceByKey[key];
        if (!bucket) {
          bucket = [];
          evidenceByKey[key] = bucket;
        }
        if (bucket.length >= limitPerRecord) continue;
        bucket.push(mapEvidenceRow(row));
      }
    }

    return c.json({
      evidenceByKey,
      currentCheckerModel: CURRENT_CHECKER_MODEL,
    });
  })

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
      .update(recordSources)
      .set({
        fieldName: body.fieldName ?? null,
        entityId: body.entityId ?? null,
        expectedValue: body.expectedValue ?? null,
        resourceId: body.resourceId ?? null,
        extractedValue: body.extractedValue ?? null,
        extractedQuote: body.extractedQuote ?? null,
        verdict: body.verdict,
        confidence: body.confidence ?? null,
        relevanceScore: body.relevanceScore ?? null,
        isPrimarySource: body.isPrimarySource,
        notes: body.notes ?? null,
        checkedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(recordSources.recordType, body.recordType),
          eq(recordSources.recordId, body.recordId),
          sql`COALESCE(${recordSources.sourceUrl}, '') = ${sourceUrlForLookup}`,
          sql`COALESCE(${recordSources.checkerModel}, '') = ${checkerModelForLookup}`,
        )
      )
      .returning({ id: recordSources.id });

    let evidenceId: number;
    let wasUpdated: boolean;

    if (updated.length > 0) {
      evidenceId = updated[0].id;
      wasUpdated = true;
    } else {
      // No existing row found — insert a new one
      try {
        const [inserted] = await db
          .insert(recordSources)
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
            relevanceScore: body.relevanceScore ?? null,
            isPrimarySource: body.isPrimarySource,
            checkerModel: checkerModelVal,
            notes: body.notes ?? null,
            checkedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: recordSources.id });

        evidenceId = inserted.id;
        wasUpdated = false;
      } catch (insertErr: unknown) {
        // Race condition: another request inserted between our UPDATE and INSERT.
        // Retry the UPDATE which should now find the row.
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr);
        if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("23505")) {
          const retried = await db
            .update(recordSources)
            .set({
              fieldName: body.fieldName ?? null,
              entityId: body.entityId ?? null,
              expectedValue: body.expectedValue ?? null,
              resourceId: body.resourceId ?? null,
              extractedValue: body.extractedValue ?? null,
              extractedQuote: body.extractedQuote ?? null,
              verdict: body.verdict,
              confidence: body.confidence ?? null,
              relevanceScore: body.relevanceScore ?? null,
              isPrimarySource: body.isPrimarySource,
              notes: body.notes ?? null,
              checkedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(recordSources.recordType, body.recordType),
                eq(recordSources.recordId, body.recordId),
                sql`COALESCE(${recordSources.sourceUrl}, '') = ${sourceUrlForLookup}`,
                sql`COALESCE(${recordSources.checkerModel}, '') = ${checkerModelForLookup}`,
              )
            )
            .returning({ id: recordSources.id });

          evidenceId = retried[0]?.id ?? 0;
          wasUpdated = true;
        } else {
          throw insertErr;
        }
      }
    }

    // QUA-791: recompute the aggregate so it reflects the row we just
    // wrote. Best-effort — failure here doesn't fail the evidence write;
    // the next recompute call (or a periodic backfill) picks it up.
    //
    // The pre-QUA-791 handler also had a 7-day-cooldown auto-flag step
    // that set `needs_recheck=true` on stale verdicts. Recompute now
    // produces a fresh verdict from current evidence on every write, so
    // the auto-flag is redundant and was removed; `verdictFlagged` is
    // correspondingly dropped from the response (no callers consumed it).
    await recomputeVerdictBestEffort(db, {
      recordType: body.recordType,
      recordId: body.recordId,
      fieldName: body.fieldName ?? null,
      entityId: body.entityId ?? null,
    });

    return c.json(
      {
        id: evidenceId,
        wasUpdated,
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
        ne(recordSources.checkerModel, CURRENT_CHECKER_MODEL),
        isNull(recordSources.checkerModel),
      ),
    ];

    if (record_type) {
      conditions.push(eq(recordSources.recordType, record_type));
    }

    const whereClause = and(...conditions);

    const rows = await db
      .select()
      .from(recordSources)
      .where(whereClause)
      .orderBy(desc(recordSources.checkedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(recordSources)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      evidence: rows.map(mapEvidenceRow),
      total,
      currentCheckerModel: CURRENT_CHECKER_MODEL,
    });
  })

  // ---- GET /by-entity/:entityId ----
  // Returns all verdicts for a given entity with aggregate counts by verdict type.
  .get(
    "/by-entity/:entityId",
    zv("query", ByEntityQuery),
    async (c) => {
      const entityId = c.req.param("entityId");
      const { limit, offset, verdict } = c.req.valid("query");

      if (entityId.length > MAX_ID_LENGTH) {
        return c.json({
          verdicts: [] as ReturnType<typeof mapVerdictRow>[],
          total: 0,
          counts: { confirmed: 0, contradicted: 0, outdated: 0, partial: 0, unverifiable: 0, unchecked: 0 },
        });
      }

      const db = getDrizzleDb();

      const conditions = [eq(sourceVerdicts.entityId, entityId)];
      if (verdict) {
        conditions.push(eq(sourceVerdicts.verdict, verdict));
      }
      const whereClause = and(...conditions);

      const rows = await db
        .select()
        .from(sourceVerdicts)
        .where(whereClause)
        .orderBy(desc(sourceVerdicts.lastComputedAt))
        .limit(limit)
        .offset(offset);

      const countResult = await db
        .select({ count: count() })
        .from(sourceVerdicts)
        .where(whereClause);
      const total = countResult[0].count;

      // Aggregate counts by verdict type (always unfiltered by verdict param)
      const countsByVerdictRows = await db
        .select({
          verdict: sourceVerdicts.verdict,
          count: count(),
        })
        .from(sourceVerdicts)
        .where(eq(sourceVerdicts.entityId, entityId))
        .groupBy(sourceVerdicts.verdict);

      const counts: Record<string, number> = {
        confirmed: 0,
        contradicted: 0,
        outdated: 0,
        partial: 0,
        unverifiable: 0,
        unchecked: 0,
      };
      for (const row of countsByVerdictRows) {
        counts[row.verdict] = row.count;
      }

      return c.json({
        verdicts: rows.map(mapVerdictRow),
        total,
        counts,
      });
    }
  )

  // ---- GET /by-page/:pageSlug ----
  // Returns all verdicts for records whose entityId matches the page's entity stableId.
  .get(
    "/by-page/:pageSlug",
    zv("query", ByPageQuery),
    async (c) => {
      const pageSlug = c.req.param("pageSlug");
      const { limit, offset } = c.req.valid("query");

      if (pageSlug.length > MAX_ID_LENGTH) {
        return c.json({
          verdicts: [] as ReturnType<typeof mapVerdictRow>[],
          total: 0,
          counts: { confirmed: 0, contradicted: 0, outdated: 0, partial: 0, unverifiable: 0, unchecked: 0 },
          pageTitle: null as string | null,
          entityId: null as string | null,
        });
      }

      const db = getDrizzleDb();

      // Resolve page slug to entity stableId
      const entityRows = await db
        .select({ stableId: entities.stableId, title: entities.title })
        .from(entities)
        .where(eq(entities.id, pageSlug))
        .limit(1);

      if (entityRows.length === 0) {
        // Try looking up by wikiId via wikiPages
        const pageRows = await db
          .select({ slug: wikiPages.slug, wikiId: wikiPages.wikiId, title: wikiPages.title })
          .from(wikiPages)
          .where(eq(wikiPages.slug, pageSlug))
          .limit(1);

        if (pageRows.length === 0) {
          return c.json({
            verdicts: [] as ReturnType<typeof mapVerdictRow>[],
            total: 0,
            counts: { confirmed: 0, contradicted: 0, outdated: 0, partial: 0, unverifiable: 0, unchecked: 0 },
            pageTitle: null as string | null,
            entityId: null as string | null,
          });
        }

        const wikiId = pageRows[0].wikiId;
        if (wikiId) {
          const entityByWikiId = await db
            .select({ stableId: entities.stableId, title: entities.title })
            .from(entities)
            .where(eq(entities.wikiId, wikiId))
            .limit(1);

          if (entityByWikiId.length > 0) {
            const data = await queryVerdictsByEntity(db, entityByWikiId[0].stableId, pageRows[0].title, limit, offset);
            return c.json(data);
          }
        }

        return c.json({
          verdicts: [] as ReturnType<typeof mapVerdictRow>[],
          total: 0,
          counts: { confirmed: 0, contradicted: 0, outdated: 0, partial: 0, unverifiable: 0, unchecked: 0 },
          pageTitle: pageRows[0].title,
          entityId: null as string | null,
        });
      }

      const data = await queryVerdictsByEntity(db, entityRows[0].stableId, entityRows[0].title, limit, offset);
      return c.json(data);
    }
  )

  // ---- GET /failures ----
  // Returns verdicts with non-confirmed verdicts (contradicted, outdated, partial, unverifiable).
  .get(
    "/failures",
    zv("query", FailuresQuery),
    async (c) => {
      const { error_type, record_type, entity_id, limit, offset } = c.req.valid("query");
      const db = getDrizzleDb();

      const failureVerdicts = error_type ? [error_type] : [...VALID_ERROR_TYPES];

      const conditions = [inArray(sourceVerdicts.verdict, failureVerdicts)];
      if (record_type) {
        conditions.push(eq(sourceVerdicts.recordType, record_type));
      }
      if (entity_id) {
        conditions.push(eq(sourceVerdicts.entityId, entity_id));
      }

      const whereClause = and(...conditions);

      const rows = await db
        .select()
        .from(sourceVerdicts)
        .where(whereClause)
        .orderBy(desc(sourceVerdicts.lastComputedAt))
        .limit(limit)
        .offset(offset);

      const countResult = await db
        .select({ count: count() })
        .from(sourceVerdicts)
        .where(whereClause);
      const total = countResult[0].count;

      // Breakdown by error type (always unfiltered by error_type param for the summary)
      const byErrorTypeRows = await db
        .select({
          verdict: sourceVerdicts.verdict,
          count: count(),
        })
        .from(sourceVerdicts)
        .where(
          and(
            inArray(sourceVerdicts.verdict, [...VALID_ERROR_TYPES]),
            record_type ? eq(sourceVerdicts.recordType, record_type) : undefined,
            entity_id ? eq(sourceVerdicts.entityId, entity_id) : undefined,
          )
        )
        .groupBy(sourceVerdicts.verdict);

      const byErrorType: Record<string, number> = {};
      for (const row of byErrorTypeRows) {
        byErrorType[row.verdict] = row.count;
      }

      return c.json({
        items: rows.map(mapVerdictRow),
        total,
        byErrorType,
      });
    }
  )

  // ---- GET /stale ----
  // Returns verdicts that haven't been rechecked within N days.
  .get(
    "/stale",
    zv("query", StaleQuery),
    async (c) => {
      const { days, record_type, entity_id, limit, offset } = c.req.valid("query");
      const db = getDrizzleDb();

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const conditions = [lte(sourceVerdicts.lastComputedAt, cutoffDate)];
      if (record_type) {
        conditions.push(eq(sourceVerdicts.recordType, record_type));
      }
      if (entity_id) {
        conditions.push(eq(sourceVerdicts.entityId, entity_id));
      }

      const whereClause = and(...conditions);

      const rows = await db
        .select()
        .from(sourceVerdicts)
        .where(whereClause)
        .orderBy(sourceVerdicts.lastComputedAt) // oldest first
        .limit(limit)
        .offset(offset);

      const countResult = await db
        .select({ count: count() })
        .from(sourceVerdicts)
        .where(whereClause);
      const total = countResult[0].count;

      return c.json({
        items: rows.map(mapVerdictRow),
        total,
        cutoffDate: cutoffDate.toISOString(),
        days,
      });
    }
  )

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
    // QUA-661: coerce raw stableIds to NULL before persisting. Display-name
    // columns must hold human-readable names or NULL — never a raw `sid_`.
    // Callers that pass an unresolved sid_ get a NULL here (honest signal of
    // "unknown") plus a warn-level log so the leak is traceable back to the
    // source code path.
    const displayNameVal = coerceDisplayName(
      body.displayName ?? null,
      "displayName",
      body.recordType,
      body.recordId,
    );
    const entityDisplayNameVal = coerceDisplayName(
      body.entityDisplayName ?? null,
      "entityDisplayName",
      body.recordType,
      body.recordId,
    );

    // Use Drizzle ORM insert/update instead of raw SQL to avoid driver issues
    // with bare literals and COALESCE expressions.
    const fieldNameForLookup = fieldNameVal ?? "";
    const confidenceVal = body.confidence ?? null;
    const reasoningVal = body.reasoning ?? null;
    const sourcesCheckedVal = body.sourcesChecked ?? 0;
    const nextCheckDueVal = body.nextCheckDue ? new Date(body.nextCheckDue) : null;
    // QUA-313: default false (legacy behavior — clear the flag after a
    // successful verdict write). Operators can queue targeted rechecks by
    // passing `needsRecheck: true` explicitly.
    const needsRecheckVal = body.needsRecheck ?? false;

    // Try update first
    const updated = await db
      .update(sourceVerdicts)
      .set({
        entityId: entityIdVal,
        displayName: displayNameVal,
        entityDisplayName: entityDisplayNameVal,
        verdict: body.verdict,
        confidence: confidenceVal,
        reasoning: reasoningVal,
        sourcesChecked: sourcesCheckedVal,
        needsRecheck: needsRecheckVal,
        nextCheckDue: nextCheckDueVal,
        lastComputedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(sourceVerdicts.recordType, body.recordType),
          eq(sourceVerdicts.recordId, body.recordId),
          sql`COALESCE(${sourceVerdicts.fieldName}, '') = ${fieldNameForLookup}`,
        )
      )
      .returning({ recordId: sourceVerdicts.recordId });

    if (updated.length === 0) {
      try {
        await db
          .insert(sourceVerdicts)
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
            needsRecheck: needsRecheckVal,
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
            .update(sourceVerdicts)
            .set({
              entityId: entityIdVal,
              displayName: displayNameVal,
              entityDisplayName: entityDisplayNameVal,
              verdict: body.verdict,
              confidence: confidenceVal,
              reasoning: reasoningVal,
              sourcesChecked: sourcesCheckedVal,
              needsRecheck: needsRecheckVal,
              nextCheckDue: nextCheckDueVal,
              lastComputedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(sourceVerdicts.recordType, body.recordType),
                eq(sourceVerdicts.recordId, body.recordId),
                sql`COALESCE(${sourceVerdicts.fieldName}, '') = ${fieldNameForLookup}`,
              )
            );
        } else {
          throw insertErr;
        }
      }
    }

    // QUA-791: reconcile the persisted aggregate against all evidence rows.
    // Best-effort. `recomputeVerdict` is a no-op (no DB writes) when the key
    // has no evidence rows, which preserves back-compat for verdict-only
    // marker writes.
    await recomputeVerdictBestEffort(db, {
      recordType: body.recordType,
      recordId: body.recordId,
      fieldName: fieldNameVal,
      entityId: entityIdVal,
      displayName: displayNameVal,
      entityDisplayName: entityDisplayNameVal,
    });

    return c.json({ ok: true }, 200);
  })

  // ---- POST /verdicts/recompute (QUA-791) ----
  //
  // Single canonical aggregation: read all evidence rows for
  // (recordType, recordId, fieldName), apply the relevance-weighted rule
  // from `sourcing-aggregation.ts`, upsert `source_check_verdicts`.
  //
  // Replaces the pre-Phase-1 last-writer-wins behavior at POST /verdicts.
  // POST /verdicts itself still works for back-compat but now also calls
  // this same code path so the persisted aggregate matches the rule.
  .post("/verdicts/recompute", async (c) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const parsed = VerdictRecomputeBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const body = parsed.data;
    const db = getDrizzleDb();

    const displayNameVal = coerceDisplayName(
      body.displayName ?? null,
      "displayName",
      body.recordType,
      body.recordId,
    );
    const entityDisplayNameVal = coerceDisplayName(
      body.entityDisplayName ?? null,
      "entityDisplayName",
      body.recordType,
      body.recordId,
    );

    const result = await recomputeVerdict(db, {
      recordType: body.recordType,
      recordId: body.recordId,
      fieldName: body.fieldName ?? null,
      entityId: body.entityId ?? null,
      displayName: displayNameVal,
      entityDisplayName: entityDisplayNameVal,
    });

    return c.json({
      ok: true,
      recordType: result.recordType,
      recordId: result.recordId,
      fieldName: result.fieldName,
      verdict: result.aggregate.verdict,
      confidence: result.aggregate.confidence,
      sourcesChecked: result.aggregate.sourcesChecked,
      droppedNotApplicable: result.aggregate.droppedNotApplicable,
      contributing: result.aggregate.contributing,
      reasoning: result.reasoning,
    });
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
        recordId: sourceVerdicts.recordId,
        displayName: sourceVerdicts.displayName,
      })
      .from(sourceVerdicts)
      .where(
        and(
          eq(sourceVerdicts.recordType, record_type),
          inArray(sourceVerdicts.recordId, record_ids),
          isNull(sourceVerdicts.fieldName),
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
      // QUA-507: reads `things_search` MV (title lives there post denorm drop).
      const rows = await db
        .select({
          sourceId: thingsSearch.sourceId,
          title: thingsSearch.title,
        })
        .from(thingsSearch)
        .where(
          and(
            eq(thingsSearch.sourceTable, record_type),
            inArray(thingsSearch.sourceId, idsToResolve)
          )
        );

      for (const row of rows) {
        names[row.sourceId] = row.title;
      }
    }

    // ---- Fallback for orphaned records ----
    // Records that were deleted/re-imported after sourcing won't be found
    // by the type-specific queries above. For those, extract a display name from
    // the verdict reasoning in source_check_verdicts + the linked entity title.
    const unresolved = record_ids.filter((id) => !names[id]);
    if (unresolved.length > 0) {
      const fallbackRows = await db
        .select({
          recordId: sourceVerdicts.recordId,
          entityId: sourceVerdicts.entityId,
          reasoning: sourceVerdicts.reasoning,
          entityTitle: entities.title,
        })
        .from(sourceVerdicts)
        .leftJoin(entities, eq(entities.stableId, sourceVerdicts.entityId))
        .where(
          and(
            eq(sourceVerdicts.recordType, record_type),
            inArray(sourceVerdicts.recordId, unresolved),
            isNull(sourceVerdicts.fieldName),
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
      UNION ALL
      SELECT 'scorecard_grade', count(*)::int FROM scorecard_grades
    `);

    const totalsByType: Record<string, number> = {};
    for (const row of tableCountResult) {
      const { table_name, total } = row as { table_name: string; total: number };
      if (typeof table_name === "string" && typeof total === "number") {
        totalsByType[table_name] = total;
      }
    }

    // QUA-928: count "checkable" facts — those eligible for sourcing by
    // collector design. A fact is checkable when it carries a source URL AND
    // its property is not flagged `verifiable: false` in properties.yaml
    // (e.g. social-media handles, wikipedia-url self-references, unsourced
    // estimates). Non-fact record types have no per-record exclusion logic
    // upstream, so checkable == total for them.
    const checkableFactsCount = await countCheckableFacts(db);

    // Count distinct verified records per record_type from source_check_verdicts.
    //
    // QUA-422: INNER JOIN against LIVE_RECORDS_CTE to exclude orphan verdicts
    // (rows referencing records deleted from their source table). Without this
    // filter, grant/personnel counts exceeded 100% in prod (5889/5876 grants,
    // 1212/975 personnel) because cleanup-orphans had not yet run. QUA-317
    // already applied the same pattern to /stats; /coverage-matrix and
    // /verdict-matrix have always used it. This endpoint was the outlier.
    //
    // Semantics note: /coverage counts ANY verdict row as "verified" (including
    // verdict='unchecked'), while /coverage-matrix filters `verdict != 'unchecked'`
    // as its `checkedRecords` metric. Keeping /coverage's broader semantic to
    // avoid a breaking change to dashboard consumers (see
    // apps/web/src/app/internal/entity-sourcing/coverage-bars.tsx); both
    // endpoints now filter orphans identically.
    // QUA-426: exclude not_applicable verdicts from the "verified" count.
    // These are pre-LLM relevance-gate short-circuits — the page didn't
    // mention the subject so nothing was actually verified. Counting them
    // would inflate the dashboard's coverage %.
    const verifiedRowsRaw = (await db.execute(sql`
      WITH ${LIVE_RECORDS_CTE}
      SELECT v.record_type, count(DISTINCT v.record_id)::int AS verified
      FROM source_check_verdicts v
      INNER JOIN live_records lr
        ON lr.record_type = v.record_type AND lr.record_id = v.record_id
      WHERE v.verdict <> 'not_applicable'
      GROUP BY v.record_type
    `)) as Array<{ record_type: string; verified: number }>;

    const verifiedByType: Record<string, number> = {};
    for (const row of verifiedRowsRaw) {
      verifiedByType[row.record_type] = row.verified;
    }

    // QUA-928: separate "checked" count for the new percentages, using the
    // strict semantic that matches /coverage-matrix (excludes both
    // 'unchecked' and 'not_applicable'). Without this, /coverage and
    // /coverage-matrix would emit different `checkableCoveragePercent`
    // numbers under the same field name. The legacy `verified` count
    // (above) is preserved for the unchanged `percentage` field that
    // `CoverageBars` + `EntitySourcingViewer` consume.
    const checkedRowsRaw = (await db.execute(sql`
      WITH ${LIVE_RECORDS_CTE}
      SELECT v.record_type, count(DISTINCT v.record_id)::int AS checked_records
      FROM source_check_verdicts v
      INNER JOIN live_records lr
        ON lr.record_type = v.record_type AND lr.record_id = v.record_id
      WHERE v.verdict NOT IN ('unchecked', 'not_applicable')
      GROUP BY v.record_type
    `)) as Array<{ record_type: string; checked_records: number }>;

    const checkedByType: Record<string, number> = {};
    for (const row of checkedRowsRaw) {
      checkedByType[row.record_type] = row.checked_records;
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
        const checked = checkedByType[recordType] ?? 0;
        const checkable = checkableCountFor(recordType, total, checkableFactsCount);
        const exempt = isSourcingExempt(recordType);
        // `percentage` retains its legacy semantics (verified / total, where
        // "verified" includes verdict='unchecked') for the existing callers
        // (`CoverageBars`, `EntitySourcingViewer`). New callers should consume
        // the explicit `*Percent` fields below — see QUA-928.
        const percentage =
          total > 0 ? Math.round((verified / total) * 10000) / 100 : 0;
        return {
          recordType,
          total,
          checkable,
          verified,
          percentage,
          ...coveragePercents(total, checkable, checked),
          exempt,
        };
      })
      .sort((a, b) => a.recordType.localeCompare(b.recordType));

    return c.json({ coverage, exemptTypes: [...SOURCING_EXEMPT_TYPES] });
  })

  // ---- GET /due-for-recheck ----
  .get("/due-for-recheck", zv("query", DueForRecheckQuery), async (c) => {
    const { limit, offset, record_type, min_priority } = c.req.valid("query");
    const db = getDrizzleDb();

    // Build priority CASE expression based on verdict severity
    const priorityExpr = sql<number>`CASE ${sourceVerdicts.verdict}
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
      lte(sourceVerdicts.nextCheckDue, sql`NOW()`),
      eq(sourceVerdicts.needsRecheck, true),
    );

    const conditions = [dueConditions];
    if (record_type) {
      conditions.push(eq(sourceVerdicts.recordType, record_type));
    }
    // Exclude exempt types from the recheck queue — they don't need verification
    if (SOURCING_EXEMPT_TYPES.length > 0) {
      conditions.push(
        sql`${sourceVerdicts.recordType} NOT IN (${sql.join(
          SOURCING_EXEMPT_TYPES.map((t) => sql`${t}`),
          sql`, `,
        )})`,
      );
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
        recordType: sourceVerdicts.recordType,
        recordId: sourceVerdicts.recordId,
        fieldName: sourceVerdicts.fieldName,
        entityId: sourceVerdicts.entityId,
        verdict: sourceVerdicts.verdict,
        confidence: sourceVerdicts.confidence,
        reasoning: sourceVerdicts.reasoning,
        sourcesChecked: sourceVerdicts.sourcesChecked,
        needsRecheck: sourceVerdicts.needsRecheck,
        nextCheckDue: sourceVerdicts.nextCheckDue,
        lastComputedAt: sourceVerdicts.lastComputedAt,
        createdAt: sourceVerdicts.createdAt,
        updatedAt: sourceVerdicts.updatedAt,
        priority: priorityExpr,
      })
      .from(sourceVerdicts)
      .where(whereClause)
      .orderBy(sql`${priorityExpr} DESC`, desc(sourceVerdicts.lastComputedAt))
      .limit(limit)
      .offset(offset);

    // Count total matching rows (includes min_priority filter)
    const countResult = await db
      .select({ count: count() })
      .from(sourceVerdicts)
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
  })

  // ---- GET /entity-summary ----
  // Returns per-entity aggregated sourcing verdict counts in a single query.
  // Used by the entities dashboard to show sourcing columns.
  .get("/entity-summary", async (c) => {
    const db = getDrizzleDb();

    // QUA-426: `not_applicable` rows are excluded from this summary entirely.
    // They are pre-LLM relevance-gate short-circuits that carry no signal —
    // counting them in `total_verdicts` would make the dashboard show entities
    // as "checked" when the only evidence was "page doesn't mention subject".
    const rows = (await db.execute(sql`
      WITH verdict_counts AS (
        SELECT
          entity_id,
          COUNT(*) FILTER (WHERE verdict = 'confirmed')   AS confirmed,
          COUNT(*) FILTER (WHERE verdict = 'contradicted') AS contradicted,
          COUNT(*) FILTER (WHERE verdict = 'outdated')     AS outdated,
          COUNT(*) FILTER (WHERE verdict = 'partial')      AS partial_count,
          COUNT(*) FILTER (WHERE verdict = 'unverifiable') AS unverifiable,
          COUNT(*) FILTER (WHERE verdict = 'unchecked')    AS unchecked,
          COUNT(*)                                         AS total_verdicts,
          COALESCE(AVG(confidence), 0)                     AS avg_confidence
        FROM source_check_verdicts
        WHERE entity_id IS NOT NULL
          AND verdict <> 'not_applicable'
        GROUP BY entity_id
      ),
      record_counts AS (
        SELECT
          t2.source_id AS entity_id,
          COUNT(t1.id) AS total_records
        FROM things t1
        JOIN things t2 ON t1.parent_thing_id = t2.id
        WHERE t2.thing_type = 'entity'
        GROUP BY t2.source_id
      ),
      all_entities AS (
        SELECT entity_id FROM verdict_counts
        UNION
        SELECT entity_id FROM record_counts
      )
      SELECT
        e.entity_id,
        COALESCE(vc.confirmed, 0) AS confirmed,
        COALESCE(vc.contradicted, 0) AS contradicted,
        COALESCE(vc.outdated, 0) AS outdated,
        COALESCE(vc.partial_count, 0) AS partial_count,
        COALESCE(vc.unverifiable, 0) AS unverifiable,
        COALESCE(vc.unchecked, 0) AS unchecked,
        COALESCE(vc.total_verdicts, 0) AS total_verdicts,
        COALESCE(vc.avg_confidence, 0) AS avg_confidence,
        COALESCE(rc.total_records, 0) AS total_records
      FROM all_entities e
      LEFT JOIN verdict_counts vc ON vc.entity_id = e.entity_id
      LEFT JOIN record_counts rc ON rc.entity_id = e.entity_id
    `)) as Record<string, unknown>[];

    const summaries = rows.map((r) => ({
      entityId: String(r.entity_id),
      confirmed: Number(r.confirmed),
      contradicted: Number(r.contradicted),
      outdated: Number(r.outdated),
      partial: Number(r.partial_count),
      unverifiable: Number(r.unverifiable),
      unchecked: Number(r.unchecked),
      totalVerdicts: Number(r.total_verdicts),
      avgConfidence: Number(Number(r.avg_confidence).toFixed(3)),
      totalRecords: Number(r.total_records),
    }));

    return c.json({ summaries });
  })

  // ---- GET /coverage-matrix ----
  // Per-record-type breakdown of total records vs verdict distribution.
  // Shows which record types have coverage and where the gaps are.
  .get("/coverage-matrix", async (c) => {
    const db = getDrizzleDb();

    // 1. Total records per table (same query as /coverage)
    const tableCountResult = await db.execute(sql`
      SELECT 'personnel' AS record_type, count(*)::int AS total FROM personnel
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
      UNION ALL
      SELECT 'scorecard_grade', count(*)::int FROM scorecard_grades
    `);

    const totalsByType: Record<string, number> = {};
    for (const row of tableCountResult) {
      const r = row as { record_type: string; total: number };
      if (typeof r.record_type === "string" && typeof r.total === "number") {
        totalsByType[r.record_type] = r.total;
      }
    }

    // 2. Verdict counts grouped by record_type and verdict
    // 3. Distinct checked records per type
    //
    // Both queries filter out orphaned verdicts (verdict rows referencing records
    // that have been deleted from their source table) by JOINing against the
    // shared LIVE_RECORDS_CTE.
    const verdictRows = (await db.execute(sql`
      WITH ${LIVE_RECORDS_CTE}
      SELECT v.record_type, v.verdict, count(*)::int AS cnt
      FROM source_check_verdicts v
      INNER JOIN live_records lr
        ON lr.record_type = v.record_type AND lr.record_id = v.record_id
      GROUP BY v.record_type, v.verdict
      ORDER BY v.record_type, v.verdict
    `)) as Array<{ record_type: string; verdict: string; cnt: number }>;

    // Coverage is based on distinct checked records, not verdict row counts.
    // A record can have multiple verdict rows (one per fieldName), so we use
    // COUNT(DISTINCT record_id) to avoid exceeding 100%.
    // QUA-426: `not_applicable` is excluded alongside `unchecked` — neither
    // is a real "the source actually addressed this" signal.
    const checkedRows = (await db.execute(sql`
      WITH ${LIVE_RECORDS_CTE}
      SELECT v.record_type, count(DISTINCT v.record_id)::int AS checked_records
      FROM source_check_verdicts v
      INNER JOIN live_records lr
        ON lr.record_type = v.record_type AND lr.record_id = v.record_id
      WHERE v.verdict NOT IN ('unchecked', 'not_applicable')
      GROUP BY v.record_type
    `)) as Array<{ record_type: string; checked_records: number }>;

    const checkedByType: Record<string, number> = {};
    for (const row of checkedRows) {
      checkedByType[row.record_type] = row.checked_records;
    }

    // Build per-type verdict maps
    const verdictsByType: Record<string, Record<string, number>> = {};
    for (const row of verdictRows) {
      if (!verdictsByType[row.record_type]) {
        verdictsByType[row.record_type] = {};
      }
      verdictsByType[row.record_type][row.verdict] = row.cnt;
    }

    // QUA-928: count checkable facts (the only recordType with per-record
    // exclusion logic — see countCheckableFacts above).
    const checkableFactsCount = await countCheckableFacts(db);

    // 4. Merge into tables array
    const allTypes = new Set([
      ...Object.keys(totalsByType),
      ...Object.keys(verdictsByType),
    ]);

    // Grand totals exclude exempt types — they don't participate in coverage metrics
    let grandTotalRecords = 0;
    let grandCheckableRecords = 0;
    let grandCheckedRecords = 0;
    let grandTotalVerdicts = 0;
    let grandConfirmed = 0;

    const tables = Array.from(allTypes)
      .map((recordType) => {
        const totalRecords = totalsByType[recordType] ?? 0;
        const verdicts = verdictsByType[recordType] ?? {};
        const checkedRecords = checkedByType[recordType] ?? 0;
        const checkableRecords = checkableCountFor(
          recordType,
          totalRecords,
          checkableFactsCount,
        );
        const exempt = isSourcingExempt(recordType);

        const confirmed = verdicts["confirmed"] ?? 0;
        const partial = verdicts["partial"] ?? 0;
        const unverifiable = verdicts["unverifiable"] ?? 0;
        const contradicted = verdicts["contradicted"] ?? 0;
        const outdated = verdicts["outdated"] ?? 0;
        const unchecked = verdicts["unchecked"] ?? 0;

        const totalVerdicts =
          confirmed + partial + unverifiable + contradicted + outdated + unchecked;

        const greenPercent = pct1(confirmed, totalVerdicts);

        // Only non-exempt types contribute to grand totals
        if (!exempt) {
          grandTotalRecords += totalRecords;
          grandCheckableRecords += checkableRecords;
          grandCheckedRecords += checkedRecords;
          grandTotalVerdicts += totalVerdicts;
          grandConfirmed += confirmed;
        }

        return {
          recordType,
          totalRecords,
          checkableRecords,
          checkedRecords,
          verdicts: {
            confirmed,
            partial,
            unverifiable,
            contradicted,
            outdated,
            unchecked,
          },
          // QUA-928: three explicit percentages — see coveragePercents().
          // - checkabilityPercent: authoring quality (sources present? properties verifiable?)
          // - checkableCoveragePercent: verification quality (gate metric for QUA-852)
          // - fullCoveragePercent: joint metric, capped by checkability
          ...coveragePercents(totalRecords, checkableRecords, checkedRecords),
          greenPercent,
          exempt,
        };
      })
      .sort((a, b) => b.totalRecords - a.totalRecords);

    return c.json({
      tables,
      totals: {
        totalRecords: grandTotalRecords,
        checkableRecords: grandCheckableRecords,
        // QUA-928 review: expose checkedRecords in aggregate totals so
        // downstream consumers can render a semantically correct "Checked"
        // total instead of falling back to totalVerdicts (which over-counts
        // because a single record can have multiple per-field verdict rows).
        checkedRecords: grandCheckedRecords,
        totalVerdicts: grandTotalVerdicts,
        confirmedPercent: pct1(grandConfirmed, grandTotalVerdicts),
        ...coveragePercents(
          grandTotalRecords,
          grandCheckableRecords,
          grandCheckedRecords,
        ),
      },
      exemptTypes: [...SOURCING_EXEMPT_TYPES],
    });
  })

  // ---- GET /verdict-matrix ----
  // Cross-tabulation of verdict x record_type.
  // Rows are record types, columns are verdict types, cells are counts.
  .get("/verdict-matrix", async (c) => {
    const db = getDrizzleDb();

    // Exclude orphaned verdicts for deleted records via the shared LIVE_RECORDS_CTE.
    const rows = (await db.execute(sql`
      WITH ${LIVE_RECORDS_CTE}
      SELECT v.record_type, v.verdict, count(*)::int AS cnt
      FROM source_check_verdicts v
      INNER JOIN live_records lr
        ON lr.record_type = v.record_type AND lr.record_id = v.record_id
      GROUP BY v.record_type, v.verdict
      ORDER BY v.record_type, v.verdict
    `)) as Array<{ record_type: string; verdict: string; cnt: number }>;

    // Build the matrix: { recordType: { verdict: count } }
    const matrix: Record<string, Record<string, number>> = {};
    const totals: Record<string, number> = {};

    for (const row of rows) {
      if (!matrix[row.record_type]) {
        matrix[row.record_type] = {};
      }
      matrix[row.record_type][row.verdict] = row.cnt;
      totals[row.verdict] = (totals[row.verdict] ?? 0) + row.cnt;
    }

    return c.json({ matrix, totals, exemptTypes: [...SOURCING_EXEMPT_TYPES] });
  })

  // ---- POST /cleanup-orphans (QUA-149) ----
  //
  // Delete verdict / evidence / url-suggestion rows whose (record_type, record_id)
  // no longer has a live row in its source table. Dashboard stats filter orphans
  // out at query time via LIVE_RECORDS_CTE, but the underlying rows accumulate
  // (e.g., 1002 personnel verdicts for 724 records) and skew any raw COUNT(*).
  //
  // Safety rails:
  //   - `dryRun` defaults to true. Pass `dryRun: false` explicitly to delete.
  //   - Only record_types listed in LIVE_RECORDS_CTE are touched. Rows with an
  //     unknown record_type are left alone.
  //   - All deletes run inside a single transaction.
  .post("/cleanup-orphans", async (c) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const parsed = CleanupOrphansBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { dryRun, recordType } = parsed.data;
    const db = getDrizzleDb();

    // Per-table type-filter clauses. Each DELETE/SELECT uses a different
    // table alias, so the filter has to be parameterized by alias.
    const verdictTypeFilter = recordType
      ? sql`AND v.record_type = ${recordType}`
      : sql``;
    const evidenceTypeFilter = recordType
      ? sql`AND e.record_type = ${recordType}`
      : sql``;
    const suggestionTypeFilter = recordType
      ? sql`AND s.record_type = ${recordType}`
      : sql``;

    // Aggregate returns { byType, counts } where counts.verdicts is the
    // sum across all types. For DELETE RETURNING we get one row per
    // deleted record; for the dry-run GROUP BY we get one row per type
    // with a pre-computed `cnt`.
    type GroupRow = { record_type: string; cnt: number };
    const aggregate = (
      verdictGroups: readonly GroupRow[],
      evidenceGroups: readonly GroupRow[],
      suggestionGroups: readonly GroupRow[],
    ) => {
      const byType: Record<
        string,
        { verdicts: number; evidence: number; suggestions: number }
      > = {};
      const bump = (
        type: string,
        key: "verdicts" | "evidence" | "suggestions",
        delta: number,
      ) => {
        const slot =
          byType[type] ?? { verdicts: 0, evidence: 0, suggestions: 0 };
        slot[key] += delta;
        byType[type] = slot;
      };
      let verdicts = 0;
      let evidence = 0;
      let suggestions = 0;
      for (const r of verdictGroups) {
        const n = Number(r.cnt);
        bump(r.record_type, "verdicts", n);
        verdicts += n;
      }
      for (const r of evidenceGroups) {
        const n = Number(r.cnt);
        bump(r.record_type, "evidence", n);
        evidence += n;
      }
      for (const r of suggestionGroups) {
        const n = Number(r.cnt);
        bump(r.record_type, "suggestions", n);
        suggestions += n;
      }
      return { byType, counts: { verdicts, evidence, suggestions } };
    };

    if (dryRun) {
      // Dry-run: GROUP BY returns O(types) rows regardless of orphan
      // count, so a million-row orphan set still fits in memory. No
      // transaction because nothing is mutated; the reported counts
      // may legitimately drift by the time a later --apply runs.
      const [verdictGroups, evidenceGroups, suggestionGroups] =
        await Promise.all([
          db.execute<GroupRow>(sql`
            WITH ${LIVE_RECORDS_CTE}
            SELECT v.record_type, count(*)::int AS cnt
            FROM source_check_verdicts v
            WHERE v.record_type IN (SELECT DISTINCT record_type FROM live_records)
              ${verdictTypeFilter}
              AND NOT EXISTS (
                SELECT 1 FROM live_records lr
                WHERE lr.record_type = v.record_type AND lr.record_id = v.record_id
              )
            GROUP BY v.record_type
          `),
          db.execute<GroupRow>(sql`
            WITH ${LIVE_RECORDS_CTE}
            SELECT e.record_type, count(*)::int AS cnt
            FROM source_check_evidence e
            WHERE e.record_type IN (SELECT DISTINCT record_type FROM live_records)
              ${evidenceTypeFilter}
              AND NOT EXISTS (
                SELECT 1 FROM live_records lr
                WHERE lr.record_type = e.record_type AND lr.record_id = e.record_id
              )
            GROUP BY e.record_type
          `),
          db.execute<GroupRow>(sql`
            WITH ${LIVE_RECORDS_CTE}
            SELECT s.record_type, count(*)::int AS cnt
            FROM sourcing_url_suggestions s
            WHERE s.record_type IN (SELECT DISTINCT record_type FROM live_records)
              ${suggestionTypeFilter}
              AND NOT EXISTS (
                SELECT 1 FROM live_records lr
                WHERE lr.record_type = s.record_type AND lr.record_id = s.record_id
              )
            GROUP BY s.record_type
          `),
        ]);

      const { byType, counts } = aggregate(
        verdictGroups,
        evidenceGroups,
        suggestionGroups,
      );
      return c.json({ dryRun: true, deleted: counts, byType });
    }

    // Non-dry-run: `DELETE … RETURNING record_type` inside a transaction
    // gives the exact set of rows removed, so the reported byType/counts
    // always reflect the actual DB state change — no TOCTOU gap between
    // a pre-count SELECT and the DELETE. We then GROUP the returned rows
    // in-process (O(rows) Node memory, but the row count is bounded by
    // what we just removed — on the order of hundreds in practice).
    const deleted = await db.transaction(async (tx) => {
      const v = await tx.execute<{ record_type: string }>(sql`
        WITH ${LIVE_RECORDS_CTE}
        DELETE FROM source_check_verdicts v
        WHERE v.record_type IN (SELECT DISTINCT record_type FROM live_records)
          ${verdictTypeFilter}
          AND NOT EXISTS (
            SELECT 1 FROM live_records lr
            WHERE lr.record_type = v.record_type AND lr.record_id = v.record_id
          )
        RETURNING v.record_type
      `);
      const e = await tx.execute<{ record_type: string }>(sql`
        WITH ${LIVE_RECORDS_CTE}
        DELETE FROM source_check_evidence e
        WHERE e.record_type IN (SELECT DISTINCT record_type FROM live_records)
          ${evidenceTypeFilter}
          AND NOT EXISTS (
            SELECT 1 FROM live_records lr
            WHERE lr.record_type = e.record_type AND lr.record_id = e.record_id
          )
        RETURNING e.record_type
      `);
      const s = await tx.execute<{ record_type: string }>(sql`
        WITH ${LIVE_RECORDS_CTE}
        DELETE FROM sourcing_url_suggestions s
        WHERE s.record_type IN (SELECT DISTINCT record_type FROM live_records)
          ${suggestionTypeFilter}
          AND NOT EXISTS (
            SELECT 1 FROM live_records lr
            WHERE lr.record_type = s.record_type AND lr.record_id = s.record_id
          )
        RETURNING s.record_type
      `);
      return { v, e, s };
    });

    // Convert the raw RETURNING rows into GroupRow shape (one row per
    // record_type with a cnt) so the aggregate helper can share code
    // with the dry-run path.
    const toGroups = (rows: readonly { record_type: string }[]): GroupRow[] => {
      const counts = new Map<string, number>();
      for (const r of rows) {
        counts.set(r.record_type, (counts.get(r.record_type) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([record_type, cnt]) => ({
        record_type,
        cnt,
      }));
    };

    const { byType, counts } = aggregate(
      toGroups(deleted.v),
      toGroups(deleted.e),
      toGroups(deleted.s),
    );
    return c.json({ dryRun: false, deleted: counts, byType });
  });

// ---- Exports ----

export const sourcingRoute = sourcingApp;
export type SourcingRoute = typeof sourcingApp;
