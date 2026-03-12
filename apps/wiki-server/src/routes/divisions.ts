import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { divisions } from "../schema.js";
import {
  paginationQuery,
  noDuplicateIds,
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  zv,
} from "./utils.js";

// ---- Constants ----

const VALID_DIVISION_TYPES = [
  "fund",
  "team",
  "department",
  "lab",
  "program-area",
] as const;

const VALID_STATUSES = ["active", "inactive", "dissolved"] as const;

// ---- Query schemas ----

const AllQuery = paginationQuery({ defaultLimit: 200 }).extend({
  division_type: z.enum(VALID_DIVISION_TYPES).optional(),
  status: z.enum(VALID_STATUSES).optional(),
});

const ByOrgQuery = paginationQuery({ defaultLimit: 100 }).extend({
  division_type: z.enum(VALID_DIVISION_TYPES).optional(),
});

// ---- Sync schema ----

const SyncDivisionItemSchema = z.object({
  id: z.string().length(10),
  slug: z.string().max(200).nullable().optional(),
  parentOrgId: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  divisionType: z.enum(VALID_DIVISION_TYPES),
  lead: z.string().max(500).nullable().optional(),
  status: z.enum(VALID_STATUSES).nullable().optional(),
  startDate: z.string().max(20).nullable().optional(),
  endDate: z.string().max(20).nullable().optional(),
  website: z.string().max(2000).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncDivisionsBatchSchema = z.object({
  items: z
    .array(SyncDivisionItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" })
    .refine(
      (items) => {
        const slugs = items.map((i) => i.slug).filter((s) => s != null);
        return new Set(slugs).size === slugs.length;
      },
      { message: "Duplicate slug values in items array" }
    ),
});

// ---- Helpers ----

function formatRow(r: typeof divisions.$inferSelect) {
  return {
    id: r.id,
    slug: r.slug,
    parentOrgId: r.parentOrgId,
    name: r.name,
    divisionType: r.divisionType,
    lead: r.lead,
    status: r.status,
    startDate: r.startDate,
    endDate: r.endDate,
    website: r.website,
    source: r.source,
    notes: r.notes,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const divisionsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        fund: sql<number>`count(*) filter (where ${divisions.divisionType} = 'fund')`,
        team: sql<number>`count(*) filter (where ${divisions.divisionType} = 'team')`,
        department: sql<number>`count(*) filter (where ${divisions.divisionType} = 'department')`,
        lab: sql<number>`count(*) filter (where ${divisions.divisionType} = 'lab')`,
        programArea: sql<number>`count(*) filter (where ${divisions.divisionType} = 'program-area')`,
        active: sql<number>`count(*) filter (where ${divisions.status} = 'active')`,
        inactive: sql<number>`count(*) filter (where ${divisions.status} = 'inactive')`,
        dissolved: sql<number>`count(*) filter (where ${divisions.status} = 'dissolved')`,
      })
      .from(divisions);

    return c.json({
      total: statsRow.total,
      byType: {
        fund: Number(statsRow.fund),
        team: Number(statsRow.team),
        department: Number(statsRow.department),
        lab: Number(statsRow.lab),
        "program-area": Number(statsRow.programArea),
      },
      byStatus: {
        active: Number(statsRow.active),
        inactive: Number(statsRow.inactive),
        dissolved: Number(statsRow.dissolved),
      },
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { division_type, status, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (division_type)
      conditions.push(eq(divisions.divisionType, division_type));
    if (status) conditions.push(eq(divisions.status, status));
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(divisions)
      .where(whereClause)
      .orderBy(desc(divisions.syncedAt), desc(divisions.id))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(divisions)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      divisions: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-org/:orgId ----
  .get("/by-org/:orgId", zv("query", ByOrgQuery), async (c) => {
    const orgId = c.req.param("orgId");
    const { division_type, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [eq(divisions.parentOrgId, orgId)];
    if (division_type)
      conditions.push(eq(divisions.divisionType, division_type));
    const whereClause = and(...conditions);

    const rows = await db
      .select()
      .from(divisions)
      .where(whereClause)
      .orderBy(desc(divisions.syncedAt), desc(divisions.id))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(divisions)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      orgId,
      divisions: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /:id ----
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(divisions)
      .where(eq(divisions.id, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Division ${id} not found`);
    }

    return c.json(formatRow(rows[0]));
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncDivisionsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
        id: item.id,
        slug: item.slug ?? null,
        parentOrgId: item.parentOrgId,
        name: item.name,
        divisionType: item.divisionType,
        lead: item.lead ?? null,
        status: item.status ?? null,
        startDate: item.startDate ?? null,
        endDate: item.endDate ?? null,
        website: item.website ?? null,
        source: item.source ?? null,
        notes: item.notes ?? null,
      }));

      await tx
        .insert(divisions)
        .values(allVals)
        .onConflictDoUpdate({
          target: divisions.id,
          set: {
            slug: sql`excluded.slug`,
            parentOrgId: sql`excluded.parent_org_id`,
            name: sql`excluded.name`,
            divisionType: sql`excluded.division_type`,
            // COALESCE: preserve existing values when sync payload sends null
            lead: sql`COALESCE(excluded.lead, ${divisions.lead})`,
            status: sql`COALESCE(excluded.status, ${divisions.status})`,
            startDate: sql`COALESCE(excluded.start_date, ${divisions.startDate})`,
            endDate: sql`COALESCE(excluded.end_date, ${divisions.endDate})`,
            website: sql`COALESCE(excluded.website, ${divisions.website})`,
            source: sql`COALESCE(excluded.source, ${divisions.source})`,
            notes: sql`COALESCE(excluded.notes, ${divisions.notes})`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const divisionsRoute = divisionsApp;
export type DivisionsRoute = typeof divisionsApp;
