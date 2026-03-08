/**
 * Statements route — Hono RPC method-chained route for the Statements system.
 *
 * - GET /          — list with filters (by entity, property, variety, status)
 * - GET /current   — current value for entity+property (valid_end IS NULL)
 * - GET /by-page   — all statements for a page with citations and footnote links
 * - GET /by-page/summary — per-footnote verification summary for citation dots
 * - GET /properties       — list all properties with statement counts
 * - POST /properties/upsert — batch upsert properties
 * - GET /stats             — basic statistics
 * - GET /quality-summary — aggregate quality distribution + per-entity coverage scores
 * - GET /export    — export entity statements as JSON or CSV download
 * - PATCH /:id     — update statement status, verdict, or note
 * - POST /         — create statement + optional citations
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
  isNotNull,
  sql,
} from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import {
  statements,
  statementCitations,
  statementPageReferences,
  properties,
  entityCoverageScores,
  wikiPages,
  resources,
  entities,
} from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  firstOrThrow,
  VALIDATION_ERROR,
} from "./utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 500;

// ---- Query schemas ----

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  entityId: z.string().min(1).max(200).optional(),
  propertyId: z.string().min(1).max(200).optional(),
  variety: z.enum(["structured", "attributed"]).optional(),
  status: z.enum(["active", "superseded", "retracted"]).optional(),
});

const CurrentQuery = z.object({
  entityId: z.string().min(1).max(200),
  propertyId: z.string().min(1).max(200),
});

const ByEntityQuery = z.object({
  entityId: z.string().min(1).max(200),
  includeChildren: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

const ByPageQuery = z.object({
  pageId: z.coerce.number().int().positive(),
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
    verdict: s.verdict,
    verdictScore: s.verdictScore,
    verdictQuotes: s.verdictQuotes,
    verdictModel: s.verdictModel,
    verifiedAt: s.verifiedAt,
    claimCategory: s.claimCategory,
    sourceFactKey: s.sourceFactKey,
    note: s.note,
    qualityScore: s.qualityScore,
    qualityDimensions: s.qualityDimensions,
    scoredAt: s.scoredAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ---- Body schemas ----

// Strict schema for quality dimensions — enforces exactly the 10 known keys
// and rejects unknown ones. Using z.object().strict() means extra keys cause a
// 400 error rather than being silently stored in the DB. Values must be finite
// numbers in [0, 1] — rejects NaN, Infinity, null, and out-of-range values.
// Exported for unit testing.
export const QualityDimensionsSchema = z.object({
  structure:          z.number().min(0).max(1).finite(),
  precision:          z.number().min(0).max(1).finite(),
  clarity:            z.number().min(0).max(1).finite(),
  resolvability:      z.number().min(0).max(1).finite(),
  uniqueness:         z.number().min(0).max(1).finite(),
  atomicity:          z.number().min(0).max(1).finite(),
  importance:         z.number().min(0).max(1).finite(),
  neglectedness:      z.number().min(0).max(1).finite(),
  recency:            z.number().min(0).max(1).finite(),
  crossEntityUtility: z.number().min(0).max(1).finite(),
}).strict();

// Exported for unit testing.
export const BatchScoreBody = z.object({
  scores: z.array(z.object({
    statementId: z.number().int().positive(),
    qualityScore: z.number().min(0).max(1).finite(),
    qualityDimensions: QualityDimensionsSchema,
  })).min(1).max(500),
});

// Exported for unit testing.
export const CoverageScoreBody = z.object({
  entityId: z.string().min(1).max(200),
  coverageScore: z.number().min(0).max(1).finite(),
  // Category keys are dynamic (derived from property.category at runtime),
  // so we can't enumerate them statically. We do enforce values are finite and in [0, 1].
  categoryScores: z.record(z.number().min(0).max(1).finite()),
  statementCount: z.number().int().min(0),
  qualityAvg: z.number().min(0).max(1).finite().nullish(),
});

const CoverageScoreQuery = z.object({
  entityId: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Exported for unit testing.
export const PatchStatementBody = z.object({
  status: z.enum(["active", "superseded", "retracted"]).optional(),
  variety: z.enum(["structured", "attributed"]).optional(),
  statementText: z.string().min(1).max(2000).optional(),
  subjectEntityId: z.string().min(1).max(200).optional(),
  propertyId: z.string().min(1).max(200).nullish(),
  qualifierKey: z.string().min(1).max(200).nullish(),
  validStart: z.string().min(1).max(20).nullish(),
  validEnd: z.string().min(1).max(20).nullish(),
  attributedTo: z.string().min(1).max(200).nullish(),
  archiveReason: z.string().min(1).max(2000).nullish(),
  verdict: z.string().min(1).max(50).nullish(),
  verdictScore: z.number().min(0).max(1).finite().nullish(),
  verdictQuotes: z.string().min(1).max(10000).nullish(),
  verdictModel: z.string().min(1).max(200).nullish(),
  note: z.string().min(1).max(2000).nullish(),
});

// Exported for unit testing.
export const CreateStatementBody = z.object({
  variety: z.enum(["structured", "attributed"]),
  statementText: z.string().min(1).max(2000), // Required: every statement needs human-readable text
  subjectEntityId: z.string().min(1).max(200),
  propertyId: z.string().min(1).max(200).nullish(),
  qualifierKey: z.string().min(1).max(200).nullish(),
  valueNumeric: z.number().finite().nullish(),
  valueUnit: z.string().min(1).max(100).nullish(),
  valueText: z.string().min(1).max(2000).nullish(),
  valueEntityId: z.string().min(1).max(200).nullish(),
  valueDate: z.string().min(1).max(20).nullish(),
  valueSeries: z.record(z.unknown()).nullish(),
  validStart: z.string().min(1).max(20).nullish(),
  validEnd: z.string().min(1).max(20).nullish(),
  temporalGranularity: z.string().min(1).max(20).nullish(),
  attributedTo: z.string().min(1).max(200).nullish(),
  note: z.string().min(1).max(2000).nullish(),
  sourceFactKey: z.string().min(1).max(200).nullish(),
  claimCategory: z.string().min(1).max(50).nullish(),
  verdict: z.string().min(1).max(50).nullish(),
  verdictScore: z.number().min(0).max(1).finite().nullish(),
  verdictModel: z.string().min(1).max(200).nullish(),
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
  pageReferences: z
    .array(
      z.object({
        pageIdInt: z.number().int().positive(),
        footnoteResourceId: z.string().max(200).nullish(),
        section: z.string().max(500).nullish(),
      })
    )
    .optional()
    .default([]),
});

const BatchCreateBody = z.object({
  statements: z.array(CreateStatementBody).min(1).max(100),
});

const ClearByEntityQuery = z.object({
  entityId: z.string().min(1).max(200),
});

// ---- Pipeline quality gate validation ----

/** Property IDs that represent financial values where $0 is almost always a data error. */
const FINANCIAL_PROPERTY_IDS = new Set([
  "revenue",
  "valuation",
  "funding-round",
  "operating-expenses",
]);

/** Maximum plausible benchmark score. ELO caps ~2000, percentages at 100, raw scores rarely exceed 10000. */
const MAX_BENCHMARK_SCORE = 10000;

/**
 * Validate a parsed statement for semantic correctness beyond Zod schema checks.
 * Returns null if valid, or a descriptive error message if invalid.
 *
 * Exported for unit testing.
 */
export function validateStatementQuality(
  data: z.infer<typeof CreateStatementBody>
): string | null {
  // 1. Block empty structured statements: require at least one value field
  if (data.variety === "structured") {
    const hasValue =
      data.valueNumeric != null ||
      data.valueText != null ||
      data.valueDate != null ||
      data.valueEntityId != null ||
      data.valueSeries != null;
    if (!hasValue) {
      return "Structured statements must have at least one value field (valueNumeric, valueText, valueDate, valueEntityId, or valueSeries)";
    }
  }

  // 2. Validate benchmark score magnitudes
  if (
    data.propertyId === "benchmark-score" &&
    data.valueNumeric != null &&
    Math.abs(data.valueNumeric) > MAX_BENCHMARK_SCORE
  ) {
    return `Benchmark score ${data.valueNumeric} exceeds maximum plausible value of ${MAX_BENCHMARK_SCORE}. ELO scores cap around 2000, percentages at 100. Check if a raw score was stored with percentage format.`;
  }

  // 3. Block $0 for financial properties
  if (
    data.propertyId != null &&
    FINANCIAL_PROPERTY_IDS.has(data.propertyId) &&
    data.valueNumeric === 0
  ) {
    return `Financial property "${data.propertyId}" cannot have a value of $0. If the entity has no known value, omit the statement instead of recording zero.`;
  }

  // 4. Require statementText for attributed statements
  if (data.variety === "attributed") {
    if (!data.statementText || data.statementText.trim().length === 0) {
      return "Attributed statements must have non-empty statementText";
    }
  }

  return null;
}

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

    // Fetch citation counts for the returned statements
    const statementIds = rows.map((r) => r.id);
    const citationCounts =
      statementIds.length > 0
        ? await db
            .select({
              statementId: statementCitations.statementId,
              count: count(),
            })
            .from(statementCitations)
            .where(
              sql`${statementCitations.statementId} IN (${sql.join(
                statementIds.map((id) => sql`${id}`),
                sql`, `
              )})`
            )
            .groupBy(statementCitations.statementId)
        : [];

    const citCountMap = new Map(
      citationCounts.map((r) => [r.statementId, r.count])
    );

    return c.json({
      statements: rows.map((r) => ({
        ...formatStatement(r),
        citationCount: citCountMap.get(r.id) ?? 0,
      })),
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

  // ---- GET /by-entity — all statements for an entity, with citations and property info ----
  .get("/by-entity", zv("query", ByEntityQuery), async (c) => {
    const { entityId, includeChildren } = c.req.valid("query");
    const db = getDrizzleDb();

    // Determine which entity IDs to include
    let entityIds = [entityId];
    if (includeChildren) {
      const entityRow = await db
        .select({ relatedEntries: entities.relatedEntries })
        .from(entities)
        .where(eq(entities.id, entityId))
        .limit(1);
      if (entityRow.length > 0 && entityRow[0].relatedEntries) {
        const childIds = (
          entityRow[0].relatedEntries as Array<{ id: string; relationship?: string }>
        )
          .filter((re) => re.relationship === "composed-of")
          .map((re) => re.id);
        entityIds = [...new Set([entityId, ...childIds])];
      }
    }

    // Build where clause — single entity or multiple
    const entityMatch =
      entityIds.length === 1
        ? eq(statements.subjectEntityId, entityId)
        : sql`${statements.subjectEntityId} IN (${sql.join(
            entityIds.map((id) => sql`${id}`),
            sql`, `,
          )})`;
    const entityConditions = [entityMatch];
    entityConditions.push(sql`${statements.status} != 'retracted'`);
    const entityWhere = and(...entityConditions);

    // Build the same entity match for the citations subquery
    const citationsSubquery =
      entityIds.length === 1
        ? sql`${statements.subjectEntityId} = ${entityId}`
        : sql`${statements.subjectEntityId} IN (${sql.join(
            entityIds.map((id) => sql`${id}`),
            sql`, `,
          )})`;

    // Fetch statements, citations, and properties in parallel
    const [rows, allCitations, propertyRows] = await Promise.all([
      db
        .select()
        .from(statements)
        .where(entityWhere)
        .orderBy(desc(statements.validStart)),
      db
        .select()
        .from(statementCitations)
        .where(
          sql`${statementCitations.statementId} IN (
            SELECT ${statements.id} FROM ${statements}
            WHERE ${citationsSubquery}
            AND ${statements.status} != 'retracted'
          )`
        ),
      db.select().from(properties),
    ]);

    // Build citation map: statementId -> citations[]
    const citationMap = new Map<number, typeof allCitations>();
    for (const cit of allCitations) {
      const list = citationMap.get(cit.statementId) ?? [];
      list.push(cit);
      citationMap.set(cit.statementId, list);
    }

    // Build property map: propertyId -> property
    const propertyMap = new Map(propertyRows.map((p) => [p.id, p]));

    // Format statements with joined citations and property info
    const formatted = rows.map((s) => {
      const prop = s.propertyId ? propertyMap.get(s.propertyId) : null;
      const cits = citationMap.get(s.id) ?? [];
      return {
        ...formatStatement(s),
        property: prop
          ? {
              id: prop.id,
              label: prop.label,
              category: prop.category,
              valueType: prop.valueType,
              unitFormatId: prop.unitFormatId,
            }
          : null,
        citations: cits.map((cit) => ({
          id: cit.id,
          resourceId: cit.resourceId,
          url: cit.url,
          sourceQuote: cit.sourceQuote,
          locationNote: cit.locationNote,
          isPrimary: cit.isPrimary,
        })),
      };
    });

    // Split by variety
    const structured = formatted.filter((s) => s.variety === "structured");
    const attributed = formatted.filter((s) => s.variety === "attributed");

    return c.json({ structured, attributed, total: rows.length });
  })

  // ---- GET /by-page — all statements for a page with citations and footnote links ----
  .get("/by-page", zv("query", ByPageQuery), async (c) => {
    const { pageId } = c.req.valid("query");
    const db = getDrizzleDb();

    // Get all page references for this page
    const refs = await db
      .select()
      .from(statementPageReferences)
      .where(eq(statementPageReferences.pageIdInt, pageId));

    if (refs.length === 0) {
      return c.json({ statements: [] });
    }

    const statementIds = [...new Set(refs.map((r) => r.statementId))];

    if (statementIds.length === 0) {
      return c.json({ statements: [] });
    }

    // Fetch statements and citations in parallel
    const [stmtRows, citRows] = await Promise.all([
      db
        .select()
        .from(statements)
        .where(
          sql`${statements.id} IN (${sql.join(
            statementIds.map((id) => sql`${id}`),
            sql`, `
          )})`
        ),
      db
        .select()
        .from(statementCitations)
        .where(
          sql`${statementCitations.statementId} IN (${sql.join(
            statementIds.map((id) => sql`${id}`),
            sql`, `
          )})`
        ),
    ]);

    // Build citation map: statementId -> citations[]
    const citationMap = new Map<number, (typeof citRows)[number][]>();
    for (const cit of citRows) {
      const list = citationMap.get(cit.statementId) ?? [];
      list.push(cit);
      citationMap.set(cit.statementId, list);
    }

    // Build statement map: id -> statement
    const stmtMap = new Map(stmtRows.map((s) => [s.id, s]));

    // Build ref map: statementId -> page reference info[] (a statement can appear multiple times on a page)
    const refMap = new Map<
      number,
      Array<{ footnoteResourceId: string | null; section: string | null }>
    >();
    for (const ref of refs) {
      if (ref.statementId !== null) {
        const list = refMap.get(ref.statementId) ?? [];
        list.push({
          footnoteResourceId: ref.footnoteResourceId,
          section: ref.section,
        });
        refMap.set(ref.statementId, list);
      }
    }

    // Combine: for each statement, attach citations and page reference info
    const result = statementIds
      .map((id) => {
        const stmt = stmtMap.get(id);
        if (!stmt) return null;
        const cits = citationMap.get(id) ?? [];
        const pageRefs = refMap.get(id) ?? [];
        return {
          ...formatStatement(stmt),
          pageReferences: pageRefs,
          citations: cits.map((cit) => ({
            id: cit.id,
            resourceId: cit.resourceId,
            url: cit.url,
            sourceQuote: cit.sourceQuote,
            locationNote: cit.locationNote,
            isPrimary: cit.isPrimary,
          })),
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    return c.json({ statements: result });
  })

  // ---- GET /by-page/summary — per-footnote verification summary for citation dots ----
  .get("/by-page/summary", zv("query", ByPageQuery), async (c) => {
    const { pageId } = c.req.valid("query");
    const db = getDrizzleDb();

    // Get all page references for this page, joined with statement verdicts
    const rows = await db
      .select({
        footnoteResourceId: statementPageReferences.footnoteResourceId,
        verdict: statements.verdict,
      })
      .from(statementPageReferences)
      .innerJoin(
        statements,
        eq(statementPageReferences.statementId, statements.id)
      )
      .where(eq(statementPageReferences.pageIdInt, pageId));

    // Group by footnoteResourceId and aggregate verdicts
    const footnoteMap = new Map<
      string,
      {
        statementCount: number;
        verdicts: { verified: number; disputed: number; unchecked: number };
      }
    >();

    for (const row of rows) {
      const key = row.footnoteResourceId ?? "__none__";
      const entry = footnoteMap.get(key) ?? {
        statementCount: 0,
        verdicts: { verified: 0, disputed: 0, unchecked: 0 },
      };
      entry.statementCount++;
      if (row.verdict === "verified") {
        entry.verdicts.verified++;
      } else if (
        row.verdict === "disputed" ||
        row.verdict === "unsupported"
      ) {
        entry.verdicts.disputed++;
      } else {
        entry.verdicts.unchecked++;
      }
      footnoteMap.set(key, entry);
    }

    const footnotes = [...footnoteMap.entries()].map(([key, val]) => ({
      footnoteResourceId: key === "__none__" ? null : key,
      statementCount: val.statementCount,
      verdicts: val.verdicts,
    }));

    return c.json({ footnotes });
  })

  // ---- GET /properties — list all properties with statement counts ----
  .get("/properties", async (c) => {
    const db = getDrizzleDb();

    // Fetch all properties and count statements per property in parallel
    const [propertyRows, stmtCounts] = await Promise.all([
      db.select().from(properties),
      db
        .select({
          propertyId: statements.propertyId,
          count: count(),
        })
        .from(statements)
        .where(eq(statements.status, "active"))
        .groupBy(statements.propertyId),
    ]);

    const countMap = new Map(
      stmtCounts
        .filter((r) => r.propertyId !== null)
        .map((r) => [r.propertyId!, r.count])
    );

    return c.json({
      properties: propertyRows.map((p) => ({
        id: p.id,
        label: p.label,
        category: p.category,
        description: p.description,
        entityTypes: p.entityTypes,
        valueType: p.valueType,
        defaultUnit: p.defaultUnit,
        stalenessCadence: p.stalenessCadence,
        unitFormatId: p.unitFormatId,
        statementCount: countMap.get(p.id) ?? 0,
      })),
    });
  })

  // ---- POST /properties/upsert — batch upsert properties ----
  .post("/properties/upsert", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const schema = z.object({
      properties: z.array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          category: z.string().min(1),
          description: z.string().nullable().optional(),
          entityTypes: z.array(z.string()).default(["organization"]),
          valueType: z.enum(["number", "string", "entity", "date"]).default("string"),
          defaultUnit: z.string().nullable().optional(),
          stalenessCadence: z.string().nullable().optional(),
          unitFormatId: z.string().nullable().optional(),
        })
      ).min(1).max(100),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();
    let created = 0;
    let updated = 0;

    for (const prop of parsed.data.properties) {
      const existing = await db
        .select({ id: properties.id })
        .from(properties)
        .where(eq(properties.id, prop.id))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(properties)
          .set({
            label: prop.label,
            category: prop.category,
            description: prop.description ?? null,
            entityTypes: prop.entityTypes,
            valueType: prop.valueType,
            defaultUnit: prop.defaultUnit ?? null,
            stalenessCadence: prop.stalenessCadence ?? null,
            unitFormatId: prop.unitFormatId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(properties.id, prop.id));
        updated++;
      } else {
        await db.insert(properties).values({
          id: prop.id,
          label: prop.label,
          category: prop.category,
          description: prop.description ?? null,
          entityTypes: prop.entityTypes,
          valueType: prop.valueType,
          defaultUnit: prop.defaultUnit ?? null,
          stalenessCadence: prop.stalenessCadence ?? null,
          unitFormatId: prop.unitFormatId ?? null,
        });
        created++;
      }
    }

    return c.json({ created, updated });
  })

  // ---- GET /quality-summary — aggregate quality scores and entity coverage ----
  .get("/quality-summary", async (c) => {
    const db = getDrizzleDb();

    // Typed row shapes for raw SQL results
    type QualityDistRow = {
      total: string;
      unscored: string;
      excellent: string;
      good: string;
      fair: string;
      poor: string;
      avg_score: string | null;
      [key: string]: unknown;
    };

    type EntityCoverageRow = {
      entityId: string;
      coverageScore: unknown;
      categoryScores: Record<string, number>;
      statementCount: unknown;
      qualityAvg: unknown;
      scoredAt: string;
      [key: string]: unknown;
    };

    const [qualityResult, coverageResult] = await Promise.all([
      db.execute<QualityDistRow>(sql`
        SELECT
          COUNT(*)::text AS total,
          COUNT(*) FILTER (WHERE quality_score IS NULL)::text AS unscored,
          COUNT(*) FILTER (WHERE quality_score >= 0.8)::text AS excellent,
          COUNT(*) FILTER (WHERE quality_score >= 0.6 AND quality_score < 0.8)::text AS good,
          COUNT(*) FILTER (WHERE quality_score >= 0.4 AND quality_score < 0.6)::text AS fair,
          COUNT(*) FILTER (WHERE quality_score < 0.4 AND quality_score IS NOT NULL)::text AS poor,
          AVG(quality_score)::text AS avg_score
        FROM statements
        WHERE status = 'active'
      `),
      db.execute<EntityCoverageRow>(sql`
        SELECT DISTINCT ON (entity_id)
          entity_id AS "entityId",
          coverage_score AS "coverageScore",
          category_scores AS "categoryScores",
          statement_count AS "statementCount",
          quality_avg AS "qualityAvg",
          scored_at AS "scoredAt"
        FROM entity_coverage_scores
        -- DISTINCT ON requires entity_id first in ORDER BY to select the most-recent row per entity
        ORDER BY entity_id, scored_at DESC
      `),
    ]);

    const dist = qualityResult[0];

    return c.json({
      quality: {
        total: Number(dist?.total ?? 0),
        unscored: Number(dist?.unscored ?? 0),
        excellent: Number(dist?.excellent ?? 0),
        good: Number(dist?.good ?? 0),
        fair: Number(dist?.fair ?? 0),
        poor: Number(dist?.poor ?? 0),
        avgScore: dist?.avg_score != null ? parseFloat(dist.avg_score) : null,
      },
      entityCoverage: [...coverageResult].map((r) => ({
        entityId: r.entityId,
        coverageScore: Number(r.coverageScore),
        // Defensive: JSONB may theoretically be non-object in degenerate cases
        categoryScores:
          r.categoryScores != null && typeof r.categoryScores === "object" && !Array.isArray(r.categoryScores)
            ? (r.categoryScores as Record<string, number>)
            : {},
        statementCount: Number(r.statementCount),
        qualityAvg: r.qualityAvg != null ? Number(r.qualityAvg) : null,
        scoredAt: typeof r.scoredAt === "string" ? r.scoredAt : String(r.scoredAt),
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

  // ---- GET /coverage-scores — coverage score history for an entity ----
  // NOTE: Must be defined BEFORE /:id to prevent wildcard from matching "coverage-scores"
  .get("/coverage-scores", zv("query", CoverageScoreQuery), async (c) => {
    const { entityId, limit } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(entityCoverageScores)
      .where(eq(entityCoverageScores.entityId, entityId))
      .orderBy(desc(entityCoverageScores.scoredAt))
      .limit(limit);

    return c.json({
      scores: rows.map((r) => ({
        id: r.id,
        entityId: r.entityId,
        coverageScore: r.coverageScore,
        categoryScores: r.categoryScores,
        statementCount: r.statementCount,
        qualityAvg: r.qualityAvg,
        scoredAt: r.scoredAt,
      })),
    });
  })

  // ---- GET /coverage-scores/all — latest coverage score for every entity ----
  // NOTE: Must be defined BEFORE /:id to prevent wildcard from matching
  .get("/coverage-scores/all", async (c) => {
    const db = getDrizzleDb();

    const latestIds = db
      .select({
        maxId: sql<number>`MAX(${entityCoverageScores.id})`.as("max_id"),
      })
      .from(entityCoverageScores)
      .groupBy(entityCoverageScores.entityId)
      .as("latest");

    const rows = await db
      .select({
        id: entityCoverageScores.id,
        entityId: entityCoverageScores.entityId,
        coverageScore: entityCoverageScores.coverageScore,
        categoryScores: entityCoverageScores.categoryScores,
        statementCount: entityCoverageScores.statementCount,
        qualityAvg: entityCoverageScores.qualityAvg,
        scoredAt: entityCoverageScores.scoredAt,
      })
      .from(entityCoverageScores)
      .innerJoin(latestIds, eq(entityCoverageScores.id, latestIds.maxId))
      .orderBy(desc(entityCoverageScores.coverageScore));

    return c.json({
      scores: rows.map((r) => ({
        id: r.id,
        entityId: r.entityId,
        coverageScore: r.coverageScore,
        categoryScores: r.categoryScores,
        statementCount: r.statementCount,
        qualityAvg: r.qualityAvg,
        scoredAt: r.scoredAt,
      })),
      total: rows.length,
    });
  })

  // ---- GET /export — export statements for an entity as JSON or CSV ----
  .get("/export", zv("query", z.object({
    entityId: z.string().min(1).max(200),
    format: z.enum(["json", "csv"]).default("json"),
  })), async (c) => {
    const { entityId, format } = c.req.valid("query");
    const db = getDrizzleDb();

    // Reuse by-entity query logic: fetch statements, citations, properties
    const [rows, allCitations, propertyRows] = await Promise.all([
      db
        .select()
        .from(statements)
        .where(
          and(
            eq(statements.subjectEntityId, entityId),
            sql`${statements.status} != 'retracted'`
          )
        )
        .orderBy(desc(statements.validStart)),
      db
        .select()
        .from(statementCitations)
        .where(
          sql`${statementCitations.statementId} IN (
            SELECT ${statements.id} FROM ${statements}
            WHERE ${statements.subjectEntityId} = ${entityId}
            AND ${statements.status} != 'retracted'
          )`
        ),
      db.select().from(properties),
    ]);

    // Build citation count map
    const citationCountMap = new Map<number, number>();
    for (const cit of allCitations) {
      citationCountMap.set(cit.statementId, (citationCountMap.get(cit.statementId) ?? 0) + 1);
    }

    // Build property map
    const propertyMap = new Map(propertyRows.map((p) => [p.id, p]));

    // Format each statement with property info and citation count
    const formatted = rows.map((s) => {
      const prop = s.propertyId ? propertyMap.get(s.propertyId) : null;
      return {
        ...formatStatement(s),
        property: prop
          ? { id: prop.id, label: prop.label, category: prop.category, valueType: prop.valueType, unitFormatId: prop.unitFormatId }
          : null,
        citationsCount: citationCountMap.get(s.id) ?? 0,
      };
    });

    const structured = formatted.filter((s) => s.variety === "structured");
    const attributed = formatted.filter((s) => s.variety === "attributed");

    // Sanitize entityId for use in Content-Disposition filename
    const safeFilename = entityId.replace(/[^a-zA-Z0-9_-]/g, "_");

    if (format === "json") {
      c.header("Content-Type", "application/json");
      c.header("Content-Disposition", `attachment; filename="${safeFilename}-statements.json"`);
      return c.json({ entityId, structured, attributed, total: rows.length });
    }

    // CSV format — flatten to rows
    const csvHeaders = [
      "id", "variety", "property", "propertyCategory", "value", "statementText",
      "validStart", "validEnd", "status", "citationsCount",
      "attributedTo", "verdict", "verdictScore", "claimCategory",
    ];

    function csvEscape(val: string | number | null | undefined): string {
      if (val == null) return "";
      const str = String(val);
      // Defend against CSV injection: quote cells with dangerous leading characters
      const needsQuoting =
        str.includes(",") || str.includes('"') || str.includes("\n") ||
        /^[=+\-@\t\r]/.test(str);
      if (needsQuoting) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }

    function formatValue(s: typeof formatted[number]): string {
      if (s.valueNumeric != null) return String(s.valueNumeric) + (s.valueUnit ? ` ${s.valueUnit}` : "");
      if (s.valueText != null) return s.valueText;
      if (s.valueDate != null) return s.valueDate;
      if (s.valueEntityId != null) return s.valueEntityId;
      return "";
    }

    const csvRows = formatted.map((s) =>
      csvHeaders.map((h) => {
        switch (h) {
          case "id": return csvEscape(s.id);
          case "variety": return csvEscape(s.variety);
          case "property": return csvEscape(s.property?.label ?? s.propertyId);
          case "propertyCategory": return csvEscape(s.property?.category);
          case "value": return csvEscape(formatValue(s));
          case "statementText": return csvEscape(s.statementText);
          case "validStart": return csvEscape(s.validStart);
          case "validEnd": return csvEscape(s.validEnd);
          case "status": return csvEscape(s.status);
          case "citationsCount": return csvEscape(s.citationsCount);
          case "attributedTo": return csvEscape(s.attributedTo);
          case "verdict": return csvEscape(s.verdict);
          case "verdictScore": return csvEscape(s.verdictScore);
          case "claimCategory": return csvEscape(s.claimCategory);
          default: return "";
        }
      }).join(",")
    );

    const csvContent = [csvHeaders.join(","), ...csvRows].join("\n");

    c.header("Content-Type", "text/csv");
    c.header("Content-Disposition", `attachment; filename="${safeFilename}-statements.csv"`);
    return c.text(csvContent);
  })

  // ---- GET /:id — fetch a single statement with citations and property ----
  .get("/:id", async (c) => {
    const idParam = c.req.param("id");
    const id = parseInt(idParam, 10);
    if (isNaN(id) || id <= 0) {
      return c.json(
        { error: VALIDATION_ERROR, message: "Statement ID must be a positive integer" },
        400
      );
    }

    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(statements)
      .where(eq(statements.id, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Statement not found: ${id}`);
    }

    const stmt = rows[0];

    // Fetch citations and property in parallel
    const [citationRows, propertyRows] = await Promise.all([
      db
        .select()
        .from(statementCitations)
        .where(eq(statementCitations.statementId, id)),
      stmt.propertyId
        ? db
            .select()
            .from(properties)
            .where(eq(properties.id, stmt.propertyId))
            .limit(1)
        : Promise.resolve([]),
    ]);

    const prop = propertyRows[0] ?? null;

    return c.json({
      statement: {
        ...formatStatement(stmt),
        citationCount: citationRows.length,
      },
      citations: citationRows.map((cit) => ({
        id: cit.id,
        resourceId: cit.resourceId,
        url: cit.url,
        sourceQuote: cit.sourceQuote,
        locationNote: cit.locationNote,
        isPrimary: cit.isPrimary,
      })),
      property: prop
        ? {
            id: prop.id,
            label: prop.label,
            category: prop.category,
            description: prop.description,
            valueType: prop.valueType,
            unitFormatId: prop.unitFormatId,
          }
        : null,
    });
  })

  // ---- PATCH /:id — update statement status, verdict, or note ----
  .patch("/:id", async (c) => {
    const idParam = c.req.param("id");
    const id = parseInt(idParam, 10);
    if (isNaN(id)) {
      return c.json({ error: VALIDATION_ERROR, message: "Invalid statement ID" }, 400);
    }

    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = PatchStatementBody.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const data = parsed.data;
    const db = getDrizzleDb();

    // Build update set — inline to match codebase pattern (sql`now()` accepted at runtime)
    const rows = await db
      .update(statements)
      .set({
        ...(data.status !== undefined && { status: data.status }),
        ...(data.variety !== undefined && { variety: data.variety }),
        ...(data.statementText !== undefined && { statementText: data.statementText }),
        ...(data.subjectEntityId !== undefined && { subjectEntityId: data.subjectEntityId }),
        ...(data.propertyId !== undefined && { propertyId: data.propertyId ?? null }),
        ...(data.qualifierKey !== undefined && { qualifierKey: data.qualifierKey ?? null }),
        ...(data.validStart !== undefined && { validStart: data.validStart ?? null }),
        ...(data.validEnd !== undefined && { validEnd: data.validEnd ?? null }),
        ...(data.attributedTo !== undefined && { attributedTo: data.attributedTo ?? null }),
        ...(data.archiveReason !== undefined && { archiveReason: data.archiveReason ?? null }),
        ...(data.verdict !== undefined && { verdict: data.verdict ?? null }),
        ...(data.verdictScore !== undefined && { verdictScore: data.verdictScore ?? null }),
        ...(data.verdictQuotes !== undefined && { verdictQuotes: data.verdictQuotes ?? null }),
        ...(data.verdictModel !== undefined && { verdictModel: data.verdictModel ?? null }),
        ...(data.note !== undefined && { note: data.note ?? null }),
        updatedAt: sql`now()`,
      })
      .where(eq(statements.id, id))
      .returning();

    if (rows.length === 0) {
      return c.json({ error: "not_found", message: "Statement not found" }, 404);
    }

    return c.json({ statement: formatStatement(rows[0]), ok: true });
  })

  // ---- POST / — create statement + optional citations + page references ----
  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = CreateStatementBody.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const data = parsed.data;

    // Pipeline quality gate — reject semantically invalid statements
    const qualityError = validateStatementQuality(data);
    if (qualityError) {
      return c.json({ error: "validation_failed", message: qualityError }, 400);
    }

    const db = getDrizzleDb();

    const statementId = await db.transaction(async (tx) => {
      const result = await tx
        .insert(statements)
        .values({
          variety: data.variety,
          statementText: data.statementText,
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
          sourceFactKey: data.sourceFactKey ?? null,
          claimCategory: data.claimCategory ?? null,
          verdict: data.verdict ?? null,
          verdictScore: data.verdictScore ?? null,
          verdictModel: data.verdictModel ?? null,
          status: "active",
        })
        .returning({ id: statements.id });

      if (result.length === 0) {
        throw new Error("Statement insert returned no rows");
      }

      const id = result[0].id;

      if (data.citations.length > 0) {
        await tx.insert(statementCitations).values(
          data.citations.map((cit) => ({
            statementId: id,
            resourceId: cit.resourceId ?? null,
            url: cit.url ?? null,
            sourceQuote: cit.sourceQuote ?? null,
            locationNote: cit.locationNote ?? null,
            isPrimary: cit.isPrimary,
          }))
        );
      }

      if (data.pageReferences.length > 0) {
        await tx.insert(statementPageReferences).values(
          data.pageReferences.map((ref) => ({
            statementId: id,
            pageIdInt: ref.pageIdInt,
            footnoteResourceId: ref.footnoteResourceId ?? null,
            section: ref.section ?? null,
          }))
        );
      }

      return id;
    });

    return c.json({ id: statementId, ok: true }, 201);
  })

  // ---- POST /batch — bulk create statements ----
  .post("/batch", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = BatchCreateBody.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const items = parsed.data.statements;

    // Pipeline quality gate — validate all items before inserting any
    for (let idx = 0; idx < items.length; idx++) {
      const qualityError = validateStatementQuality(items[idx]);
      if (qualityError) {
        return c.json(
          {
            error: "validation_failed",
            message: `Statement at index ${idx}: ${qualityError}`,
          },
          400
        );
      }
    }

    const db = getDrizzleDb();

    const results: Array<{ id: number; sourceFactKey: string | null }> = [];

    await db.transaction(async (tx) => {
      for (let idx = 0; idx < items.length; idx++) {
        const data = items[idx];
        const result = await tx
          .insert(statements)
          .values({
            variety: data.variety,
            statementText: data.statementText,
            subjectEntityId: data.subjectEntityId,
            propertyId: data.propertyId ?? null,
            qualifierKey: data.qualifierKey ?? null,
            valueNumeric: data.valueNumeric ?? null,
            valueUnit: data.valueUnit ?? null,
            valueText: data.valueText ?? null,
            valueEntityId: data.valueEntityId ?? null,
            valueDate: data.valueDate ?? null,
            valueSeries:
              (data.valueSeries as Record<string, unknown>) ?? null,
            validStart: data.validStart ?? null,
            validEnd: data.validEnd ?? null,
            temporalGranularity: data.temporalGranularity ?? null,
            attributedTo: data.attributedTo ?? null,
            note: data.note ?? null,
            sourceFactKey: data.sourceFactKey ?? null,
            claimCategory: data.claimCategory ?? null,
            verdict: data.verdict ?? null,
            verdictScore: data.verdictScore ?? null,
            verdictModel: data.verdictModel ?? null,
            status: "active",
          })
          .returning({ id: statements.id });

        if (result.length === 0) {
          throw new Error(`Statement insert returned no rows for item at index ${results.length}`);
        }
        const id = result[0].id;

        if (data.citations.length > 0) {
          await tx.insert(statementCitations).values(
            data.citations.map((cit) => ({
              statementId: id,
              resourceId: cit.resourceId ?? null,
              url: cit.url ?? null,
              sourceQuote: cit.sourceQuote ?? null,
              locationNote: cit.locationNote ?? null,
              isPrimary: cit.isPrimary,
            }))
          );
        }

        if (data.pageReferences.length > 0) {
          await tx.insert(statementPageReferences).values(
            data.pageReferences.map((ref) => ({
              statementId: id,
              pageIdInt: ref.pageIdInt,
              footnoteResourceId: ref.footnoteResourceId ?? null,
              section: ref.section ?? null,
            }))
          );
        }

        results.push({
          id,
          sourceFactKey: data.sourceFactKey ?? null,
        });
      }
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      // Log the full error including Postgres detail/hint/constraint
      const pgErr = err as { detail?: string; constraint?: string; code?: string; hint?: string };
      console.error(`[statements/batch] Transaction failed at item ${results.length}: ${msg}`);
      if (pgErr.detail) console.error(`  PG detail: ${pgErr.detail}`);
      if (pgErr.hint) console.error(`  PG hint: ${pgErr.hint}`);
      if (pgErr.constraint) console.error(`  PG constraint: ${pgErr.constraint}`);
      if (pgErr.code) console.error(`  PG code: ${pgErr.code}`);
      throw err;
    });

    return c.json({ inserted: results.length, results, ok: true }, 201);
  })

  // ---- POST /score — batch update quality scores ----
  .post("/score", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = BatchScoreBody.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const { scores } = parsed.data;
    const db = getDrizzleDb();

    // Bulk UPDATE using CASE/WHEN — single query instead of N+1
    const ids = scores.map((s) => s.statementId);
    const scoreCases = sql.join(
      scores.map((s) => sql`WHEN id = ${s.statementId} THEN ${s.qualityScore}`),
      sql` `,
    );
    const dimCases = sql.join(
      scores.map((s) => sql`WHEN id = ${s.statementId} THEN ${JSON.stringify(s.qualityDimensions)}::jsonb`),
      sql` `,
    );
    const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);

    const result = await db.execute(sql`
      UPDATE statements SET
        quality_score = CASE ${scoreCases} ELSE quality_score END,
        quality_dimensions = CASE ${dimCases} ELSE quality_dimensions END,
        scored_at = now(),
        updated_at = now()
      WHERE id IN (${idList})
    `);

    const rowCount = typeof result === 'object' && result !== null && 'rowCount' in result
      ? (result as { rowCount: number }).rowCount
      : scores.length;

    const missing = scores.length - rowCount;
    if (missing > 0) {
      console.warn(`[statements/score] ${missing} of ${scores.length} statementIds not found in DB`);
    }

    return c.json({ updated: rowCount, missing, ok: true });
  })

  // ---- POST /coverage-score — store entity coverage score ----
  .post("/coverage-score", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = CoverageScoreBody.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const data = parsed.data;
    const db = getDrizzleDb();

    const result = await db
      .insert(entityCoverageScores)
      .values({
        entityId: data.entityId,
        coverageScore: data.coverageScore,
        categoryScores: data.categoryScores,
        statementCount: data.statementCount,
        qualityAvg: data.qualityAvg ?? null,
      })
      .returning({ id: entityCoverageScores.id });

    const row = firstOrThrow(result, "coverage score insert");
    return c.json({ id: row.id, ok: true }, 201);
  })

  // ---- GET /scores/distribution — quality score distribution for statements ----
  .get("/scores/distribution", async (c) => {
    const db = getDrizzleDb();

    // Aggregate distribution and category breakdown in SQL (no full table scan)
    const [summaryResult, categoryResult] = await Promise.all([
      db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE quality_score IS NULL) AS unscored,
          COUNT(*) FILTER (WHERE quality_score < 0.2) AS b0_2,
          COUNT(*) FILTER (WHERE quality_score >= 0.2 AND quality_score < 0.4) AS b2_4,
          COUNT(*) FILTER (WHERE quality_score >= 0.4 AND quality_score < 0.6) AS b4_6,
          COUNT(*) FILTER (WHERE quality_score >= 0.6 AND quality_score < 0.8) AS b6_8,
          COUNT(*) FILTER (WHERE quality_score >= 0.8) AS b8_10,
          AVG(quality_score) FILTER (WHERE quality_score IS NOT NULL) AS average_quality,
          COUNT(quality_score) AS scored_count
        FROM statements
        WHERE status = 'active'
      `),
      db.execute(sql`
        SELECT
          COALESCE(p.category, 'uncategorized') AS category,
          COUNT(*)::text AS count,
          AVG(s.quality_score) FILTER (WHERE s.quality_score IS NOT NULL) AS avg_quality
        FROM statements s
        LEFT JOIN properties p ON s.property_id = p.id
        WHERE s.status = 'active'
        GROUP BY COALESCE(p.category, 'uncategorized')
        ORDER BY COUNT(*) DESC
      `),
    ]);

    const summary = summaryResult[0];
    const bucketCounts: Record<string, number> = {
      "unscored": Number(summary?.unscored ?? 0),
      "0.0-0.2": Number(summary?.b0_2 ?? 0),
      "0.2-0.4": Number(summary?.b2_4 ?? 0),
      "0.4-0.6": Number(summary?.b4_6 ?? 0),
      "0.6-0.8": Number(summary?.b6_8 ?? 0),
      "0.8-1.0": Number(summary?.b8_10 ?? 0),
    };
    const scoredCount = Number(summary?.scored_count ?? 0);
    const averageQuality = summary?.average_quality != null
      ? Number(summary.average_quality)
      : null;

    const categoryBreakdown = categoryResult.map((row) => ({
      category: String(row.category ?? "uncategorized"),
      count: Number(row.count ?? 0),
      avgQuality: row.avg_quality != null ? Number(row.avg_quality) : null,
    }));

    const bucketOrder = ["0.0-0.2", "0.2-0.4", "0.4-0.6", "0.6-0.8", "0.8-1.0", "unscored"];

    return c.json({
      buckets: bucketOrder.map((range) => ({
        range,
        count: bucketCounts[range] ?? 0,
      })),
      averageQuality: averageQuality,
      scoredCount,
      categoryBreakdown,
    });
  })

  // ---- POST /cleanup — delete retracted and empty statements ----
  // entityId is required to prevent accidental global cleanup.
  .post("/cleanup", async (c) => {
    const body = await parseJsonBody(c);
    const parsed = z
      .object({
        entityId: z.string().min(1).max(200),
        dryRun: z.boolean().default(true),
      })
      .safeParse(body ?? {});
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { entityId, dryRun } = parsed.data;
    const db = getDrizzleDb();

    // Find retracted statements scoped to the required entityId
    const retractedConditions = [
      eq(statements.status, "retracted"),
      eq(statements.subjectEntityId, entityId),
    ];

    const retractedRows = await db
      .select({ id: statements.id, subjectEntityId: statements.subjectEntityId })
      .from(statements)
      .where(and(...retractedConditions));

    // Find empty structured statements (no property and no values) scoped to entityId
    const emptyConditions = [
      eq(statements.variety, "structured"),
      eq(statements.subjectEntityId, entityId),
      isNull(statements.propertyId),
      isNull(statements.valueNumeric),
      isNull(statements.valueText),
      isNull(statements.valueEntityId),
      isNull(statements.valueDate),
      isNull(statements.valueSeries),
    ];

    const emptyRows = await db
      .select({ id: statements.id, subjectEntityId: statements.subjectEntityId })
      .from(statements)
      .where(and(...emptyConditions));

    const allIds = [...new Set([...retractedRows.map((r) => r.id), ...emptyRows.map((r) => r.id)])];

    if (dryRun || allIds.length === 0) {
      return c.json({
        dryRun,
        retracted: retractedRows.length,
        empty: emptyRows.length,
        totalToDelete: allIds.length,
        ok: true,
      });
    }

    // Delete citations first (FK constraint), then statements — all in one transaction
    console.warn(`[statements/cleanup] Deleting ${allIds.length} statements (${retractedRows.length} retracted, ${emptyRows.length} empty)`);

    const deleted = await db.transaction(async (tx) => {
      await tx
        .delete(statementCitations)
        .where(
          sql`${statementCitations.statementId} IN (${sql.join(
            allIds.map((id) => sql`${id}`),
            sql`, `
          )})`
        );

      await tx
        .delete(statementPageReferences)
        .where(
          sql`${statementPageReferences.statementId} IN (${sql.join(
            allIds.map((id) => sql`${id}`),
            sql`, `
          )})`
        );

      return tx
        .delete(statements)
        .where(
          sql`${statements.id} IN (${sql.join(
            allIds.map((id) => sql`${id}`),
            sql`, `
          )})`
        )
        .returning({ id: statements.id });
    });

    return c.json({
      dryRun: false,
      retracted: retractedRows.length,
      empty: emptyRows.length,
      deleted: deleted.length,
      ok: true,
    });
  })

  // ---- POST /clear-by-entity — delete all statements for an entity ----
  .post("/clear-by-entity", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = ClearByEntityQuery.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.message);
    }

    const { entityId } = parsed.data;
    const db = getDrizzleDb();

    console.warn(`[statements/clear-by-entity] Deleting all statements for entity: ${entityId}`);

    // Delete dependent rows first, then statements — all in one transaction
    const deleted = await db.transaction(async (tx) => {
      // Get statement IDs for this entity first
      const toDelete = await tx
        .select({ id: statements.id })
        .from(statements)
        .where(eq(statements.subjectEntityId, entityId));

      if (toDelete.length === 0) return [];

      const ids = toDelete.map((r) => r.id);
      const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);

      await tx
        .delete(statementCitations)
        .where(sql`${statementCitations.statementId} IN (${idList})`);

      await tx
        .delete(statementPageReferences)
        .where(sql`${statementPageReferences.statementId} IN (${idList})`);

      return tx
        .delete(statements)
        .where(eq(statements.subjectEntityId, entityId))
        .returning({ id: statements.id });
    });

    return c.json({ deleted: deleted.length, ok: true });
  })

  // ---- GET /citation-dots/all — build-time bundle for citation dot overlays ----
  /**
   * Returns all statement-backed citation dot data grouped by page slug.
   * Called once at build time by buildStatementCitationDots() in build-data.mjs.
   * Joins statementPageReferences → statements → statementCitations (primary) →
   * wikiPages → resources to produce the minimal data the CitationOverlay needs.
   *
   * Only includes rows where:
   *  - footnoteResourceId IS NOT NULL (statement appears as a footnote on the page)
   *  - statement.status = 'active'
   */
  .get("/citation-dots/all", async (c) => {
    const db = getDrizzleDb();

    const rows = await db
      .select({
        pageSlug: wikiPages.slug,
        footnoteResourceId: statementPageReferences.footnoteResourceId,
        statementText: statements.statementText,
        verdict: statements.verdict,
        verdictScore: statements.verdictScore,
        verdictQuotes: statements.verdictQuotes,
        verifiedAt: statements.verifiedAt,
        citUrl: statementCitations.url,
        citResourceId: statementCitations.resourceId,
        citSourceQuote: statementCitations.sourceQuote,
        resourceTitle: resources.title,
        resourceUrl: resources.url,
        resourceType: resources.type,
      })
      .from(statementPageReferences)
      .innerJoin(statements, eq(statementPageReferences.statementId, statements.id))
      .innerJoin(wikiPages, eq(statementPageReferences.pageIdInt, wikiPages.integerIdCol))
      .leftJoin(
        statementCitations,
        and(
          eq(statementCitations.statementId, statements.id),
          eq(statementCitations.isPrimary, true)
        )
      )
      .leftJoin(resources, eq(statementCitations.resourceId, resources.id))
      .where(
        and(
          isNotNull(statementPageReferences.footnoteResourceId),
          eq(statements.status, "active")
        )
      );

    // Map statement verdicts to legacy AccuracyVerdict values expected by CitationOverlay
    function verdictToAccuracy(verdict: string | null): string | null {
      if (!verdict) return null;
      switch (verdict) {
        case "verified": return "accurate";
        case "disputed": return "inaccurate";
        case "unsupported": return "unsupported";
        case "unverified": return "not_verifiable";
        default: return null;
      }
    }

    // Group by page slug
    const pages: Record<string, Array<{
      footnoteResourceId: string;
      claimText: string;
      url: string | null;
      resourceId: string | null;
      sourceQuote: string | null;
      sourceTitle: string | null;
      sourceType: string | null;
      quoteVerified: boolean;
      accuracyVerdict: string | null;
      accuracyScore: number | null;
      accuracyIssues: string | null;
      accuracyCheckedAt: string | null;
    }>> = {};

    for (const row of rows) {
      if (!row.pageSlug || !row.footnoteResourceId) continue;

      const accuracyVerdict = verdictToAccuracy(row.verdict);
      // Include all statements with footnote references, including unverified ones
      // (which show as neutral dots in the UI)
      const quoteVerified = row.verdict === "verified";

      if (!pages[row.pageSlug]) pages[row.pageSlug] = [];
      pages[row.pageSlug].push({
        footnoteResourceId: row.footnoteResourceId,
        claimText: row.statementText ?? "",
        url: row.citUrl ?? row.resourceUrl ?? null,
        resourceId: row.citResourceId ?? null,
        sourceQuote: row.citSourceQuote ?? null,
        sourceTitle: row.resourceTitle ?? null,
        sourceType: row.resourceType ?? null,
        quoteVerified,
        accuracyVerdict,
        accuracyScore: row.verdictScore ?? null,
        accuracyIssues: null,
        accuracyCheckedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
      });
    }

    const totalPages = Object.keys(pages).length;
    const totalEntries = Object.values(pages).reduce((sum, arr) => sum + arr.length, 0);

    return c.json({ pages, totalPages, totalEntries });
  });

export const statementsRoute = statementsApp;
export type StatementsRoute = typeof statementsApp;
