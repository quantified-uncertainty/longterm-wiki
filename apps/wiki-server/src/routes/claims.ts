import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, asc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { claims } from "../schema.js";
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

  return c.json({
    total,
    byClaimType: Object.fromEntries(
      byType.map((r) => [r.claimType, r.count])
    ),
    byEntityType: Object.fromEntries(
      byEntityType.map((r) => [r.entityType, r.count])
    ),
  });
});

// ---- GET /by-entity/:entityId (claims for a specific entity) ----

claimsRoute.get("/by-entity/:entityId", async (c) => {
  const entityId = c.req.param("entityId");
  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(claims)
    .where(eq(claims.entityId, entityId))
    .orderBy(asc(claims.claimType), asc(claims.id));

  return c.json({ claims: rows.map(formatClaim) });
});

// ---- GET /all (paginated listing) ----

claimsRoute.get("/all", async (c) => {
  const parsed = PaginationQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset, entityType, claimType } = parsed.data;
  const db = getDrizzleDb();

  const conditions = [];
  if (entityType) conditions.push(eq(claims.entityType, entityType));
  if (claimType) conditions.push(eq(claims.claimType, claimType));

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
