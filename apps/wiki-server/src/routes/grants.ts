import { Hono } from "hono";
import { z } from "zod";
import { eq, and, or, ilike, count, sql, desc } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { logger } from "../logger.js";
import { grants } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  escapeIlike,
  zv,
} from "./utils.js";
import { parseSort } from "./query-helpers.js";
import { upsertThingsInTx } from "./thing-sync.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Query schemas ----

const SORT_ALLOWED = ["amount", "date", "name", "recipient"] as const;

const ByEntityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().max(200).optional(),
  sort: z.string().max(50).optional(),
  status: z.string().max(50).optional(),
  amountMin: z.coerce.number().optional(),
  amountMax: z.coerce.number().optional(),
  program: z.string().max(200).optional(),
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
  programId: z.string().max(200).nullable().optional(),
});

const SyncGrantsBatchSchema = z.object({
  items: z.array(SyncGrantItemSchema).min(1).max(500),
});

// ---- Batch grantee update schema ----

const BatchUpdateGranteeItemSchema = z.object({
  id: z.string().length(10),
  granteeId: z.string().max(200).nullable(),
});

const BatchUpdateGranteeSchema = z.object({
  items: z.array(BatchUpdateGranteeItemSchema).min(1).max(500),
});

// ---- Batch program update schema ----

const BatchUpdateProgramItemSchema = z.object({
  id: z.string().length(10),
  programId: z.string().max(200),
});

const BatchUpdateProgramSchema = z.object({
  items: z.array(BatchUpdateProgramItemSchema).min(1).max(500),
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
    programId: r.programId,
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
      .orderBy(desc(grants.syncedAt), grants.id)
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
  // Supports server-side search (?q=), sort (?sort=amount:desc),
  // and filters (?status=, ?amountMin=, ?amountMax=, ?program=).
  .get("/by-entity/:entityId", zv("query", ByEntityQuery), async (c) => {
    const entityId = c.req.param("entityId");
    const { limit, offset, q, sort, status, amountMin, amountMax, program } =
      c.req.valid("query");
    const db = getDrizzleDb();

    // Build WHERE conditions
    const conditions: SQL[] = [eq(grants.organizationId, entityId)];

    if (q) {
      const pattern = `%${escapeIlike(q.trim())}%`;
      const searchCond = or(
        ilike(grants.name, pattern),
        ilike(grants.notes, pattern),
        ilike(grants.granteeId, pattern),
        ilike(grants.programId, pattern),
      );
      if (searchCond) conditions.push(searchCond);
    }

    if (status) {
      conditions.push(eq(grants.status, status));
    }
    if (amountMin !== undefined) {
      conditions.push(sql`${grants.amount} >= ${amountMin}`);
    }
    if (amountMax !== undefined) {
      conditions.push(sql`${grants.amount} <= ${amountMax}`);
    }
    if (program) {
      conditions.push(eq(grants.programId, program));
    }

    // Safe: conditions always has at least the organizationId equality check
    const where = conditions.length === 1 ? conditions[0] : and(...conditions)!;

    // Build ORDER BY (whitelist-validated, with id tiebreaker for stable pagination)
    const { field, dir } = parseSort(sort, SORT_ALLOWED, "amount", "desc");
    const sortColMap: Record<string, SQL> = {
      amount: sql`${grants.amount}`,
      date: sql`${grants.date}`,
      name: sql`${grants.name}`,
      recipient: sql`${grants.granteeId}`,
    };
    const sortCol = sortColMap[field] ?? sql`${grants.amount}`;
    const orderClause =
      dir === "desc"
        ? sql`${sortCol} DESC NULLS LAST`
        : sql`${sortCol} ASC NULLS LAST`;

    // Filtered count
    const [{ total }] = await db
      .select({ total: count() })
      .from(grants)
      .where(where);

    // Data query
    const rows = await db
      .select()
      .from(grants)
      .where(where)
      .orderBy(orderClause, grants.id)
      .limit(limit)
      .offset(offset);

    return c.json({
      entityId,
      grants: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-org-summary ----
  .get("/by-org-summary", async (c) => {
    const db = getDrizzleDb();

    const rows = await db
      .select({
        organizationId: grants.organizationId,
        grantCount: count(),
        totalAmount: sql<number>`coalesce(sum(${grants.amount}), 0)`,
        minDate: sql<string | null>`min(${grants.date})`,
        maxDate: sql<string | null>`max(${grants.date})`,
      })
      .from(grants)
      .groupBy(grants.organizationId)
      .orderBy(sql`coalesce(sum(${grants.amount}), 0) desc`);

    return c.json({
      organizations: rows.map((r) => ({
        organizationId: r.organizationId,
        grantCount: r.grantCount,
        totalAmount: Number(r.totalAmount),
        minDate: r.minDate,
        maxDate: r.maxDate,
      })),
    });
  })

  // ---- GET /by-grantee-summary ----
  .get("/by-grantee-summary", async (c) => {
    const db = getDrizzleDb();

    const rows = await db
      .select({
        granteeId: grants.granteeId,
        grantCount: count(),
        totalAmount: sql<number>`coalesce(sum(${grants.amount}), 0)`,
      })
      .from(grants)
      .where(sql`${grants.granteeId} is not null`)
      .groupBy(grants.granteeId)
      .orderBy(sql`coalesce(sum(${grants.amount}), 0) desc`)
      .limit(50);

    return c.json({
      grantees: rows.map((r) => ({
        granteeId: r.granteeId,
        grantCount: r.grantCount,
        totalAmount: Number(r.totalAmount),
      })),
    });
  })

  // ---- GET /all-grantee-ids ----
  // Returns all grant IDs and their current granteeId values.
  // Used by the backfill command to identify grants needing entity linking.
  .get("/all-grantee-ids", async (c) => {
    const db = getDrizzleDb();

    const rows = await db
      .select({
        id: grants.id,
        granteeId: grants.granteeId,
        name: grants.name,
      })
      .from(grants);

    return c.json({
      grants: rows.map((r) => ({
        id: r.id,
        granteeId: r.granteeId,
        name: r.name,
      })),
      total: rows.length,
    });
  })

  // ---- PATCH /batch-update-grantee ----
  // Updates granteeId for multiple grants in a single transaction.
  // Used by the backfill command to link grantees to entity stableIds.
  .patch("/batch-update-grantee", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = BatchUpdateGranteeSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    // Build bulk UPDATE using VALUES pattern instead of sequential per-row updates
    const valuesList = items
      .map((item) => sql`(${item.id}, ${item.granteeId})`)
      .reduce((acc, val, i) => (i === 0 ? val : sql`${acc}, ${val}`));

    const result = await db.execute(sql`
      UPDATE grants SET grantee_id = v.grantee_id, updated_at = now()
      FROM (VALUES ${valuesList}) AS v(id, grantee_id)
      WHERE grants.id = v.id
    `);

    // db.execute returns rowCount at runtime (postgres.js) but it's not in Drizzle's type
    const updated = "rowCount" in result ? Number(result.rowCount) : items.length;

    return c.json({ updated });
  })

  // ---- GET /all-program-ids ----
  // Returns all grant IDs with their current programId, organizationId,
  // source, name, and notes. Used by backfill-program-ids to match grants
  // to funding programs.
  .get("/all-program-ids", async (c) => {
    const db = getDrizzleDb();

    const rows = await db
      .select({
        id: grants.id,
        programId: grants.programId,
        organizationId: grants.organizationId,
        source: grants.source,
        name: grants.name,
        notes: grants.notes,
      })
      .from(grants);

    return c.json({
      grants: rows.map((r) => ({
        id: r.id,
        programId: r.programId,
        organizationId: r.organizationId,
        source: r.source,
        name: r.name,
        notes: r.notes,
      })),
      total: rows.length,
    });
  })

  // ---- PATCH /batch-update-program ----
  // Updates programId for multiple grants using bulk SQL.
  // Used by the backfill-program-ids command.
  .patch("/batch-update-program", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = BatchUpdateProgramSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    logger.info(`batch-update-program: updating ${items.length} grants`);

    // Build bulk UPDATE using VALUES pattern instead of sequential per-row updates
    const valuesList = items
      .map((item) => sql`(${item.id}, ${item.programId})`)
      .reduce((acc, val, i) => (i === 0 ? val : sql`${acc}, ${val}`));

    const result = await db.execute(sql`
      UPDATE grants SET program_id = v.program_id, updated_at = now()
      FROM (VALUES ${valuesList}) AS v(id, program_id)
      WHERE grants.id = v.id
    `);

    // Touch things.updatedAt for affected grants
    const grantIds = items.map((item) => item.id);
    const thingIdList = sql.join(
      grantIds.map((id) => sql`${id}`),
      sql`, `
    );
    await db.execute(sql`
      UPDATE things SET updated_at = now()
      WHERE source_table = 'grants' AND source_id IN (${thingIdList})
    `);

    // db.execute returns rowCount at runtime (postgres.js) but it's not in Drizzle's type
    const updated = "rowCount" in result ? Number(result.rowCount) : items.length;

    return c.json({ updated });
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
        programId: item.programId ?? null,
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
            programId: sql`excluded.program_id`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });

      // Dual-write to things table
      await upsertThingsInTx(
        tx,
        items.map((g) => ({
          id: g.id,
          thingType: "grant" as const,
          title: g.name,
          sourceTable: "grants",
          sourceId: g.id,
          sourceUrl: g.source,
        }))
      );

      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const grantsRoute = grantsApp;
export type GrantsRoute = typeof grantsApp;
