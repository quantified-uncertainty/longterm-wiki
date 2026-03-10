import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { personnel } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "./utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const VALID_ROLE_TYPES = ["key-person", "board", "career"] as const;

// ---- Query schemas ----

const ByEntityQuery = z.object({
  role_type: z.enum(VALID_ROLE_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const ByPersonQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const AllQuery = z.object({
  role_type: z.enum(VALID_ROLE_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schema ----

const SyncPersonnelItemSchema = z.object({
  id: z.string().length(10),
  personId: z.string().min(1).max(200),
  organizationId: z.string().min(1).max(200),
  role: z.string().min(1).max(500),
  roleType: z.enum(VALID_ROLE_TYPES),
  startDate: z.string().max(20).nullable().optional(),
  endDate: z.string().max(20).nullable().optional(),
  isFounder: z.boolean().optional().default(false),
  appointedBy: z.string().max(500).nullable().optional(),
  background: z.string().max(2000).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncPersonnelBatchSchema = z.object({
  items: z.array(SyncPersonnelItemSchema).min(1).max(500),
});

// ---- Helpers ----

function formatRow(r: typeof personnel.$inferSelect) {
  return {
    id: r.id,
    personId: r.personId,
    organizationId: r.organizationId,
    role: r.role,
    roleType: r.roleType,
    startDate: r.startDate,
    endDate: r.endDate,
    isFounder: r.isFounder,
    appointedBy: r.appointedBy,
    background: r.background,
    source: r.source,
    notes: r.notes,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const personnelApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        keyPersons: sql<number>`count(*) filter (where ${personnel.roleType} = 'key-person')`,
        board: sql<number>`count(*) filter (where ${personnel.roleType} = 'board')`,
        career: sql<number>`count(*) filter (where ${personnel.roleType} = 'career')`,
      })
      .from(personnel);

    return c.json({
      total: statsRow.total,
      byRoleType: {
        "key-person": Number(statsRow.keyPersons),
        board: Number(statsRow.board),
        career: Number(statsRow.career),
      },
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { role_type, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (role_type) conditions.push(eq(personnel.roleType, role_type));
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(personnel)
      .where(whereClause)
      .orderBy(desc(personnel.syncedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(personnel)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      personnel: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-entity/:entityId ----
  .get("/by-entity/:entityId", zv("query", ByEntityQuery), async (c) => {
    const entityId = c.req.param("entityId");
    const { role_type, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [eq(personnel.organizationId, entityId)];
    if (role_type) conditions.push(eq(personnel.roleType, role_type));
    const whereClause = and(...conditions);

    const rows = await db
      .select()
      .from(personnel)
      .where(whereClause)
      .orderBy(desc(personnel.syncedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(personnel)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      entityId,
      personnel: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-person/:personId ----
  .get("/by-person/:personId", zv("query", ByPersonQuery), async (c) => {
    const personId = c.req.param("personId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(personnel)
      .where(eq(personnel.personId, personId))
      .orderBy(desc(personnel.syncedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(personnel)
      .where(eq(personnel.personId, personId));
    const total = countResult[0].count;

    return c.json({
      personId,
      personnel: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncPersonnelBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
        id: item.id,
        personId: item.personId,
        organizationId: item.organizationId,
        role: item.role,
        roleType: item.roleType,
        startDate: item.startDate ?? null,
        endDate: item.endDate ?? null,
        isFounder: item.isFounder,
        appointedBy: item.appointedBy ?? null,
        background: item.background ?? null,
        source: item.source ?? null,
        notes: item.notes ?? null,
      }));

      await tx
        .insert(personnel)
        .values(allVals)
        .onConflictDoUpdate({
          target: personnel.id,
          set: {
            personId: sql`excluded.person_id`,
            organizationId: sql`excluded.organization_id`,
            role: sql`excluded.role`,
            roleType: sql`excluded.role_type`,
            startDate: sql`excluded.start_date`,
            endDate: sql`excluded.end_date`,
            isFounder: sql`excluded.is_founder`,
            appointedBy: sql`excluded.appointed_by`,
            background: sql`excluded.background`,
            source: sql`excluded.source`,
            notes: sql`excluded.notes`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const personnelRoute = personnelApp;
export type PersonnelRoute = typeof personnelApp;
