import { Hono } from "hono";
import { z } from "zod";
import { eq, and, or, count, desc, asc, sql } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { claims, entities } from "../schema.js";
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
    value: d.value ?? null,
    unit: d.unit ?? null,
    confidence: d.confidence ?? null,
    sourceQuote: d.sourceQuote ?? null,
    // Enhanced fields
    claimCategory: d.claimCategory ?? null,
    relatedEntities: d.relatedEntities ?? null,
    factId: d.factId ?? null,
    resourceIds: d.resourceIds ?? null,
    section: d.section ?? d.value ?? null,
    footnoteRefs: d.footnoteRefs ?? d.unit ?? null,
  };
}

function formatClaim(r: typeof claims.$inferSelect) {
  return {
    id: r.id,
    entityId: r.entityId,
    entityType: r.entityType,
    claimType: r.claimType,
    claimText: r.claimText,
    value: r.value,
    unit: r.unit,
    confidence: r.confidence,
    sourceQuote: r.sourceQuote,
    // Enhanced fields
    claimCategory: r.claimCategory,
    relatedEntities: r.relatedEntities as string[] | null,
    factId: r.factId,
    resourceIds: r.resourceIds as string[] | null,
    section: r.section,
    footnoteRefs: r.footnoteRefs,
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

  return c.json(firstOrThrow(rows, "claim insert"), 201);
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

// ---- GET /stats ----

claimsRoute.get("/stats", async (c) => {
  const db = getDrizzleDb();

  const totalResult = await db.select({ count: count() }).from(claims);
  const total = totalResult[0].count;

  const byType = await db
    .select({
      claimType: claims.claimType,
      count: count(),
    })
    .from(claims)
    .groupBy(claims.claimType)
    .orderBy(desc(count()));

  const byEntityType = await db
    .select({
      entityType: claims.entityType,
      count: count(),
    })
    .from(claims)
    .groupBy(claims.entityType)
    .orderBy(desc(count()));

  const byCategory = await db
    .select({
      claimCategory: claims.claimCategory,
      count: count(),
    })
    .from(claims)
    .groupBy(claims.claimCategory)
    .orderBy(desc(count()));

  // Count claims that have relatedEntities (multi-entity claims)
  const multiEntityResult = await db
    .select({ count: count() })
    .from(claims)
    .where(sql`${claims.relatedEntities} IS NOT NULL AND jsonb_array_length(${claims.relatedEntities}) > 0`);
  const multiEntityCount = multiEntityResult[0].count;

  // Count claims linked to facts
  const factLinkedResult = await db
    .select({ count: count() })
    .from(claims)
    .where(sql`${claims.factId} IS NOT NULL`);
  const factLinkedCount = factLinkedResult[0].count;

  return c.json({
    total,
    byClaimType: Object.fromEntries(
      byType.map((r) => [r.claimType, r.count])
    ),
    byEntityType: Object.fromEntries(
      byEntityType.map((r) => [r.entityType, r.count])
    ),
    byClaimCategory: Object.fromEntries(
      byCategory.map((r) => [r.claimCategory ?? "uncategorized", r.count])
    ),
    multiEntityClaims: multiEntityCount,
    factLinkedClaims: factLinkedCount,
  });
});

// ---- GET /by-entity/:entityId (claims for a specific entity) ----
// Returns claims where entityId matches OR the entity appears in relatedEntities.

claimsRoute.get("/by-entity/:entityId", async (c) => {
  const entityId = c.req.param("entityId");
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

  return c.json({ claims: rows.map(formatClaim) });
});

// ---- GET /all (paginated listing) ----

claimsRoute.get("/all", async (c) => {
  const parsed = PaginationQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset, entityType, claimType, claimCategory } = parsed.data;
  const db = getDrizzleDb();

  const conditions = [];
  if (entityType) conditions.push(eq(claims.entityType, entityType));
  if (claimType) conditions.push(eq(claims.claimType, claimType));
  if (claimCategory) conditions.push(eq(claims.claimCategory, claimCategory));

  const whereClause =
    conditions.length > 0
      ? conditions.length === 1
        ? conditions[0]
        : and(...conditions)
      : undefined;

  const rows = await db
    .select()
    .from(claims)
    .where(whereClause)
    .orderBy(asc(claims.id))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: count() })
    .from(claims)
    .where(whereClause);
  const total = countResult[0].count;

  return c.json({
    claims: rows.map(formatClaim),
    total,
    limit,
    offset,
  });
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

  return c.json(formatClaim(rows[0]));
});
