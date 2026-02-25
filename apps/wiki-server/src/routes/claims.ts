import { Hono } from "hono";
import { z } from "zod";
import { eq, and, or, count, desc, asc, sql, inArray } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { claims, claimSources, entities } from "../schema.js";
import { checkRefsExist } from "./ref-check.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  firstOrThrow,
} from "./utils.js";
import {
  InsertClaimSchema as SharedInsertClaimSchema,
  InsertClaimBatchSchema,
  ClearClaimsSchema,
  ClearClaimsBySectionSchema,
} from "../api-types.js";

export const claimsRoute = new Hono();

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Schemas (from shared api-types) ----

const InsertClaimSchema = SharedInsertClaimSchema;
const InsertBatchSchema = InsertClaimBatchSchema;

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  entityType: z.string().max(100).optional(),
  claimType: z.string().max(100).optional(),
  claimCategory: z.string().max(100).optional(),
  claimMode: z.string().max(50).optional(),
  search: z.string().max(500).optional(),
  confidence: z.string().max(50).optional(),
  entityId: z.string().max(200).optional(),
  attributedTo: z.string().max(300).optional(),
  measure: z.string().max(200).optional(),
  multiEntity: z.coerce.boolean().optional(),
  hasNumericValue: z.coerce.boolean().optional(),
  includeSources: z.coerce.boolean().optional(),
  sort: z.enum(["newest", "entity", "confidence", "as_of"]).optional(),
});

const DeleteByEntitySchema = ClearClaimsSchema;

// ---- Helpers ----

type ClaimInput = z.infer<typeof InsertClaimSchema>;

function claimValues(d: ClaimInput) {
  return {
    entityId: d.entityId,
    entityType: d.entityType,
    claimType: d.claimType,
    claimText: d.claimText,
    // Legacy fields (kept for backward compat)
    value: d.value ?? null,
    unit: d.unit ?? null,
    confidence: d.confidence ?? null,
    sourceQuote: d.sourceQuote ?? null,
    // Enhanced fields (migration 0028)
    claimCategory: d.claimCategory ?? null,
    relatedEntities: d.relatedEntities ?? null,
    factId: d.factId ?? null,
    resourceIds: d.resourceIds ?? null,
    section: d.section ?? d.value ?? null,
    footnoteRefs: d.footnoteRefs ?? d.unit ?? null,
    // Phase 2 fields (migration 0029)
    claimMode: d.claimMode ?? "endorsed",
    attributedTo: d.attributedTo ?? null,
    asOf: d.asOf ?? null,
    measure: d.measure ?? null,
    valueNumeric: d.valueNumeric ?? null,
    valueLow: d.valueLow ?? null,
    valueHigh: d.valueHigh ?? null,
  };
}

type ClaimSourceRow = typeof claimSources.$inferSelect;

function formatClaimSource(s: ClaimSourceRow) {
  return {
    id: Number(s.id),
    claimId: Number(s.claimId),
    resourceId: s.resourceId,
    url: s.url,
    sourceQuote: s.sourceQuote,
    isPrimary: s.isPrimary,
    addedAt: s.addedAt,
  };
}

function formatClaim(
  r: typeof claims.$inferSelect,
  sourcesRows: ClaimSourceRow[] = []
) {
  return {
    id: Number(r.id),
    entityId: r.entityId,
    entityType: r.entityType,
    claimType: r.claimType,
    claimText: r.claimText,
    value: r.value,
    unit: r.unit,
    confidence: r.confidence,
    sourceQuote: r.sourceQuote,
    // Enhanced fields (migration 0028)
    claimCategory: r.claimCategory,
    relatedEntities: r.relatedEntities as string[] | null,
    factId: r.factId,
    resourceIds: r.resourceIds as string[] | null,
    section: r.section,
    footnoteRefs: r.footnoteRefs,
    // Phase 2 fields (migration 0029)
    claimMode: r.claimMode,
    attributedTo: r.attributedTo,
    asOf: r.asOf,
    measure: r.measure,
    valueNumeric: r.valueNumeric,
    valueLow: r.valueLow,
    valueHigh: r.valueHigh,
    sources: sourcesRows.map(formatClaimSource),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- POST / (insert single claim) ----

claimsRoute.post("/", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = InsertClaimSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const db = getDrizzleDb();

  // Validate entity reference
  const missing = await checkRefsExist(db, entities, entities.id, [parsed.data.entityId]);
  if (missing.length > 0) {
    return validationError(c, `Referenced entity not found: ${missing.join(", ")}`);
  }

  const vals = claimValues(parsed.data);

  const rows = await db
    .insert(claims)
    .values(vals)
    .returning({
      id: claims.id,
      entityId: claims.entityId,
      claimType: claims.claimType,
    });

  const inserted = firstOrThrow(rows, "claim insert");

  // Insert claim_sources if provided
  if (parsed.data.sources && parsed.data.sources.length > 0) {
    const sourceVals = parsed.data.sources.map((s) => ({
      claimId: inserted.id,
      resourceId: s.resourceId ?? null,
      url: s.url ?? null,
      sourceQuote: s.sourceQuote ?? null,
      isPrimary: s.isPrimary ?? false,
    }));
    await db.insert(claimSources).values(sourceVals);
  }

  return c.json(inserted, 201);
});

// ---- POST /batch (insert multiple claims) ----

claimsRoute.post("/batch", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = InsertBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { items } = parsed.data;
  const db = getDrizzleDb();

  // Validate entity references
  const entityIds = [...new Set(items.map((i) => i.entityId))];
  const missing = await checkRefsExist(db, entities, entities.id, entityIds);
  if (missing.length > 0) {
    return validationError(c, `Referenced entities not found: ${missing.join(", ")}`);
  }

  const allVals = items.map(claimValues);

  const results = await db
    .insert(claims)
    .values(allVals)
    .returning({
      id: claims.id,
      entityId: claims.entityId,
      claimType: claims.claimType,
    });

  // Insert claim_sources for any items that include inline sources
  const sourcesToInsert: Array<{
    claimId: number;
    resourceId: string | null;
    url: string | null;
    sourceQuote: string | null;
    isPrimary: boolean;
  }> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const result = results[i];
    if (item.sources && item.sources.length > 0 && result) {
      for (const s of item.sources) {
        sourcesToInsert.push({
          claimId: result.id,
          resourceId: s.resourceId ?? null,
          url: s.url ?? null,
          sourceQuote: s.sourceQuote ?? null,
          isPrimary: s.isPrimary ?? false,
        });
      }
    }
  }

  if (sourcesToInsert.length > 0) {
    await db.insert(claimSources).values(sourcesToInsert);
  }

  return c.json({ inserted: results.length, results }, 201);
});

// ---- POST /clear (delete all claims for an entity) ----
// NOTE: This deletes claims where `entityId` matches (primary entity only).
// Claims where the entity appears in `relatedEntities` are NOT deleted.
// This is intentional — relatedEntities are secondary references owned by
// the primary entity's extraction, and should only be removed when that
// primary entity's claims are cleared.

claimsRoute.post("/clear", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = DeleteByEntitySchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const db = getDrizzleDb();
  const deleted = await db
    .delete(claims)
    .where(eq(claims.entityId, parsed.data.entityId))
    .returning({ id: claims.id });

  return c.json({ deleted: deleted.length });
});

// ---- POST /clear-by-section (delete only claims matching entity+section) ----
// Used by resource ingestion --force to re-ingest a single resource without
// clobbering claims from page extraction or other resources.

claimsRoute.post("/clear-by-section", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = ClearClaimsBySectionSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const db = getDrizzleDb();
  const deleted = await db
    .delete(claims)
    .where(
      and(
        eq(claims.entityId, parsed.data.entityId),
        eq(claims.section, parsed.data.section)
      )
    )
    .returning({ id: claims.id });

  return c.json({ deleted: deleted.length });
});

// ---- GET /stats ----

claimsRoute.get("/stats", async (c) => {
  const db = getDrizzleDb();

  const totalResult = await db.select({ count: count() }).from(claims);
  const total = totalResult[0].count;

  const byType = await db
    .select({ claimType: claims.claimType, count: count() })
    .from(claims)
    .groupBy(claims.claimType)
    .orderBy(desc(count()));

  const byEntityType = await db
    .select({ entityType: claims.entityType, count: count() })
    .from(claims)
    .groupBy(claims.entityType)
    .orderBy(desc(count()));

  const byCategory = await db
    .select({ claimCategory: claims.claimCategory, count: count() })
    .from(claims)
    .groupBy(claims.claimCategory)
    .orderBy(desc(count()));

  const byMode = await db
    .select({ claimMode: claims.claimMode, count: count() })
    .from(claims)
    .groupBy(claims.claimMode)
    .orderBy(desc(count()));

  // Multi-entity claims
  const multiEntityResult = await db
    .select({ count: count() })
    .from(claims)
    .where(sql`${claims.relatedEntities} IS NOT NULL AND jsonb_array_length(${claims.relatedEntities}) > 0`);

  // Fact-linked claims
  const factLinkedResult = await db
    .select({ count: count() })
    .from(claims)
    .where(sql`${claims.factId} IS NOT NULL`);

  // Claims with claim_sources entries
  const withSourcesResult = await db
    .select({ count: count() })
    .from(claims)
    .where(
      sql`EXISTS (SELECT 1 FROM claim_sources cs WHERE cs.claim_id = ${claims.id})`
    );

  // Attributed claims
  const attributedResult = await db
    .select({ count: count() })
    .from(claims)
    .where(eq(claims.claimMode, "attributed"));

  // Claims with numeric value (central, low, or high)
  const numericResult = await db
    .select({ count: count() })
    .from(claims)
    .where(
      sql`${claims.valueNumeric} IS NOT NULL OR ${claims.valueLow} IS NOT NULL OR ${claims.valueHigh} IS NOT NULL`
    );

  return c.json({
    total,
    byClaimType: Object.fromEntries(byType.map((r) => [r.claimType, r.count])),
    byEntityType: Object.fromEntries(byEntityType.map((r) => [r.entityType, r.count])),
    byClaimCategory: Object.fromEntries(
      byCategory.map((r) => [r.claimCategory ?? "uncategorized", r.count])
    ),
    byClaimMode: Object.fromEntries(
      byMode.map((r) => [r.claimMode ?? "uncategorized", r.count])
    ),
    multiEntityClaims: multiEntityResult[0].count,
    factLinkedClaims: factLinkedResult[0].count,
    withSourcesClaims: withSourcesResult[0].count,
    attributedClaims: attributedResult[0].count,
    numericClaims: numericResult[0].count,
  });
});

// ---- GET /by-entity/:entityId (claims for a specific entity) ----
// Returns claims where entityId matches OR the entity appears in relatedEntities.

claimsRoute.get("/by-entity/:entityId", async (c) => {
  const entityId = c.req.param("entityId");
  const includeSources = c.req.query("includeSources") === "true";
  const db = getDrizzleDb();

  // Query: primary entity match OR entity appears in the relatedEntities JSONB array
  const rows = await db
    .select()
    .from(claims)
    .where(
      or(
        eq(claims.entityId, entityId),
        sql`${claims.relatedEntities} @> ${JSON.stringify([entityId])}::jsonb`
      )
    )
    .orderBy(asc(claims.claimType), asc(claims.id));

  let sourcesMap = new Map<number, typeof claimSources.$inferSelect[]>();
  if (includeSources && rows.length > 0) {
    const claimIds = rows.map((r) => r.id);
    const sourcesRows = await db
      .select()
      .from(claimSources)
      .where(inArray(claimSources.claimId, claimIds));
    for (const s of sourcesRows) {
      const id = Number(s.claimId);
      if (!sourcesMap.has(id)) sourcesMap.set(id, []);
      sourcesMap.get(id)!.push(s);
    }
  }

  return c.json({
    claims: rows.map((r) => formatClaim(r, sourcesMap.get(Number(r.id)) ?? [])),
  });
});

// ---- GET /all (paginated listing) ----

claimsRoute.get("/all", async (c) => {
  const parsed = PaginationQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const {
    limit, offset, entityType, claimType, claimCategory, claimMode,
    search, confidence, entityId, attributedTo, measure,
    multiEntity, hasNumericValue, includeSources, sort,
  } = parsed.data;
  const db = getDrizzleDb();

  const conditions = [];
  if (entityType) conditions.push(eq(claims.entityType, entityType));
  if (claimType) conditions.push(eq(claims.claimType, claimType));
  if (claimCategory) conditions.push(eq(claims.claimCategory, claimCategory));
  if (claimMode) conditions.push(eq(claims.claimMode, claimMode));
  if (search) conditions.push(sql`${claims.claimText} ILIKE ${"%" + search + "%"}`);
  if (confidence) conditions.push(eq(claims.confidence, confidence));
  if (entityId) conditions.push(eq(claims.entityId, entityId));
  if (attributedTo) conditions.push(eq(claims.attributedTo, attributedTo));
  if (measure) conditions.push(eq(claims.measure, measure));
  if (multiEntity) {
    conditions.push(
      sql`${claims.relatedEntities} IS NOT NULL AND jsonb_array_length(${claims.relatedEntities}) > 0`
    );
  }
  if (hasNumericValue) {
    conditions.push(sql`${claims.valueNumeric} IS NOT NULL`);
  }

  const whereClause =
    conditions.length > 0
      ? conditions.length === 1
        ? conditions[0]
        : and(...conditions)
      : undefined;

  const orderBy =
    sort === "newest" ? desc(claims.id)
    : sort === "entity" ? asc(claims.entityId)
    : sort === "confidence" ? asc(claims.confidence)
    : sort === "as_of" ? desc(claims.asOf)
    : asc(claims.id);

  const rows = await db
    .select()
    .from(claims)
    .where(whereClause)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: count() })
    .from(claims)
    .where(whereClause);
  const total = countResult[0].count;

  let sourcesMap = new Map<number, typeof claimSources.$inferSelect[]>();
  if (includeSources && rows.length > 0) {
    const claimIds = rows.map((r) => r.id);
    const sourcesRows = await db
      .select()
      .from(claimSources)
      .where(inArray(claimSources.claimId, claimIds));
    for (const s of sourcesRows) {
      const id = Number(s.claimId);
      if (!sourcesMap.has(id)) sourcesMap.set(id, []);
      sourcesMap.get(id)!.push(s);
    }
  }

  return c.json({
    claims: rows.map((r) => formatClaim(r, sourcesMap.get(Number(r.id)) ?? [])),
    total,
    limit,
    offset,
  });
});

// ---- GET /relationships (entity-pair relationships) ----

claimsRoute.get("/relationships", async (c) => {
  const db = getDrizzleDb();
  const rows = await db
    .select()
    .from(claims)
    .where(
      sql`${claims.relatedEntities} IS NOT NULL AND jsonb_array_length(${claims.relatedEntities}) > 0`
    );

  const pairMap = new Map<
    string,
    { entityA: string; entityB: string; claimCount: number; sampleClaims: string[] }
  >();

  for (const row of rows) {
    const related = row.relatedEntities as string[] | null;
    if (!related) continue;
    for (const rel of related) {
      const [a, b] = [row.entityId, rel].sort();
      const key = `${a}|||${b}`;
      if (!pairMap.has(key)) {
        pairMap.set(key, { entityA: a, entityB: b, claimCount: 0, sampleClaims: [] });
      }
      const entry = pairMap.get(key)!;
      entry.claimCount++;
      if (entry.sampleClaims.length < 3) {
        entry.sampleClaims.push(row.claimText.slice(0, 150));
      }
    }
  }

  const relationships = [...pairMap.values()].sort((a, b) => b.claimCount - a.claimCount);
  return c.json({ relationships });
});

// ---- GET /network (graph-ready node/edge data) ----

claimsRoute.get("/network", async (c) => {
  const db = getDrizzleDb();

  const entityCounts = await db
    .select({ entityId: claims.entityId, count: count() })
    .from(claims)
    .groupBy(claims.entityId);

  const rows = await db
    .select()
    .from(claims)
    .where(
      sql`${claims.relatedEntities} IS NOT NULL AND jsonb_array_length(${claims.relatedEntities}) > 0`
    );

  const edgeMap = new Map<string, { source: string; target: string; weight: number }>();
  const nodeIds = new Set<string>();

  for (const row of rows) {
    nodeIds.add(row.entityId);
    const related = row.relatedEntities as string[] | null;
    if (!related) continue;
    for (const rel of related) {
      nodeIds.add(rel);
      const [source, target] = [row.entityId, rel].sort();
      const key = `${source}|||${target}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, { source, target, weight: 0 });
      }
      edgeMap.get(key)!.weight++;
    }
  }

  const countMap = Object.fromEntries(
    entityCounts.map((r) => [r.entityId, r.count])
  );
  const nodes = [...nodeIds].map((id) => ({
    entityId: id,
    claimCount: countMap[id] ?? 0,
  }));
  const edges = [...edgeMap.values()].sort((a, b) => b.weight - a.weight);

  return c.json({ nodes, edges });
});

// ---- GET /:id/sources (sources for a specific claim) ----

claimsRoute.get("/:id/sources", async (c) => {
  const idStr = c.req.param("id");
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) {
    return validationError(c, "Claim ID must be a positive integer");
  }

  const db = getDrizzleDb();
  const rows = await db
    .select()
    .from(claimSources)
    .where(eq(claimSources.claimId, id))
    .orderBy(desc(claimSources.isPrimary), asc(claimSources.addedAt));

  return c.json({ sources: rows.map(formatClaimSource) });
});

// ---- POST /:id/sources (add a source to a claim) ----

const AddClaimSourceSchema = z.object({
  resourceId: z.string().max(300).nullable().optional(),
  url: z.string().max(2000).nullable().optional(),
  sourceQuote: z.string().max(10000).nullable().optional(),
  isPrimary: z.boolean().optional(),
});

claimsRoute.post("/:id/sources", async (c) => {
  const idStr = c.req.param("id");
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) {
    return validationError(c, "Claim ID must be a positive integer");
  }

  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = AddClaimSourceSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const db = getDrizzleDb();

  // Verify claim exists
  const claimRows = await db
    .select({ id: claims.id })
    .from(claims)
    .where(eq(claims.id, id))
    .limit(1);

  if (claimRows.length === 0) {
    return notFoundError(c, `Claim not found: ${id}`);
  }

  const rows = await db
    .insert(claimSources)
    .values({
      claimId: id,
      resourceId: parsed.data.resourceId ?? null,
      url: parsed.data.url ?? null,
      sourceQuote: parsed.data.sourceQuote ?? null,
      isPrimary: parsed.data.isPrimary ?? false,
    })
    .returning();

  return c.json(formatClaimSource(firstOrThrow(rows, "claim_source insert")), 201);
});

// ---- GET /:id (get by ID) ----

claimsRoute.get("/:id", async (c) => {
  const idStr = c.req.param("id");
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) {
    return validationError(c, "Claim ID must be a positive integer");
  }

  const db = getDrizzleDb();
  const rows = await db
    .select()
    .from(claims)
    .where(eq(claims.id, id))
    .limit(1);

  if (rows.length === 0) {
    return notFoundError(c, `Claim not found: ${id}`);
  }

  // Always include sources for single claim fetches
  const sourcesRows = await db
    .select()
    .from(claimSources)
    .where(eq(claimSources.claimId, id))
    .orderBy(desc(claimSources.isPrimary), asc(claimSources.addedAt));

  return c.json(formatClaim(rows[0], sourcesRows));
});
