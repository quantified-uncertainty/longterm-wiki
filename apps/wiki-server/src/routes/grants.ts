import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { grants } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "./utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Query schemas ----

const ByEntityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const AllQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schema ----

const SyncGrantItemSchema = z.object({
  id: z.string().length(10),
  organizationId: z.string().min(1).max(200),
  granteeId: z.string().max(200).nullable().optional(),
  name: z.string().min(1).max(500),
  amount: z.number().nullable().optional(),
  currency: z.string().max(10).optional().default("USD"),
  period: z.string().max(100).nullable().optional(),
  date: z.string().max(20).nullable().optional(),
  status: z.string().max(50).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncGrantsBatchSchema = z.object({
  items: z.array(SyncGrantItemSchema).min(1).max(500),
});

// ---- Helpers ----

function formatRow(r: typeof grants.$inferSelect) {
  return {
    id: r.id,
    organizationId: r.organizationId,
    granteeId: r.granteeId,
    name: r.name,
    amount: r.amount != null ? Number(r.amount) : null,
    currency: r.currency,
    period: r.period,
    date: r.date,
    status: r.status,
    source: r.source,
    notes: r.notes,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const grantsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        totalAmount: sql<number>`coalesce(sum(${grants.amount}), 0)`,
        uniqueOrgs: sql<number>`count(distinct ${grants.organizationId})`,
      })
      .from(grants);

    return c.json({
      total: statsRow.total,
      totalAmount: Number(statsRow.totalAmount),
      uniqueOrganizations: Number(statsRow.uniqueOrgs),
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(grants)
      .orderBy(desc(grants.syncedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(grants);
    const total = countResult[0].count;

    return c.json({
      grants: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-entity/:entityId ----
  .get("/by-entity/:entityId", zv("query", ByEntityQuery), async (c) => {
    const entityId = c.req.param("entityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(grants)
      .where(eq(grants.organizationId, entityId))
      .orderBy(desc(grants.syncedAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(grants)
      .where(eq(grants.organizationId, entityId));
    const total = countResult[0].count;

    return c.json({
      entityId,
      grants: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncGrantsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
        id: item.id,
        organizationId: item.organizationId,
        granteeId: item.granteeId ?? null,
        name: item.name,
        amount: item.amount != null ? String(item.amount) : null,
        currency: item.currency,
        period: item.period ?? null,
        date: item.date ?? null,
        status: item.status ?? null,
        source: item.source ?? null,
        notes: item.notes ?? null,
      }));

      await tx
        .insert(grants)
        .values(allVals)
        .onConflictDoUpdate({
          target: grants.id,
          set: {
            organizationId: sql`excluded.organization_id`,
            granteeId: sql`excluded.grantee_id`,
            name: sql`excluded.name`,
            amount: sql`excluded.amount`,
            currency: sql`excluded.currency`,
            period: sql`excluded.period`,
            date: sql`excluded.date`,
            status: sql`excluded.status`,
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

export const grantsRoute = grantsApp;
export type GrantsRoute = typeof grantsApp;
