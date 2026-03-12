import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { fundingPrograms } from "../schema.js";
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

const VALID_PROGRAM_TYPES = [
  "rfp",
  "grant-round",
  "fellowship",
  "prize",
  "solicitation",
  "call",
] as const;

const VALID_STATUSES = ["open", "closed", "awarded"] as const;

// ---- Query schemas ----

const programFilters = {
  program_type: z.enum(VALID_PROGRAM_TYPES).optional(),
  status: z.enum(VALID_STATUSES).optional(),
};

const AllQuery = paginationQuery({ defaultLimit: 200 }).extend(programFilters);
const ScopedQuery = paginationQuery({ defaultLimit: 100 }).extend(programFilters);

// ---- Sync schema ----

const SyncFundingProgramItemSchema = z.object({
  id: z.string().length(10),
  orgId: z.string().min(1).max(200),
  divisionId: z.string().max(200).nullable().optional(),
  name: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().optional(),
  programType: z.enum(VALID_PROGRAM_TYPES),
  totalBudget: z.number().nullable().optional(),
  currency: z.string().max(10).optional().default("USD"),
  applicationUrl: z.string().max(2000).nullable().optional(),
  openDate: z.string().max(20).nullable().optional(),
  deadline: z.string().max(20).nullable().optional(),
  status: z.enum(VALID_STATUSES).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncFundingProgramsBatchSchema = z.object({
  items: z
    .array(SyncFundingProgramItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
});

// ---- Helpers ----

function formatRow(r: typeof fundingPrograms.$inferSelect) {
  return {
    id: r.id,
    orgId: r.orgId,
    divisionId: r.divisionId,
    name: r.name,
    description: r.description,
    programType: r.programType,
    totalBudget: r.totalBudget != null ? Number(r.totalBudget) : null,
    currency: r.currency,
    applicationUrl: r.applicationUrl,
    openDate: r.openDate,
    deadline: r.deadline,
    status: r.status,
    source: r.source,
    notes: r.notes,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const fundingProgramsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        totalBudget: sql<number>`coalesce(sum(${fundingPrograms.totalBudget}), 0)`,
        rfp: sql<number>`count(*) filter (where ${fundingPrograms.programType} = 'rfp')`,
        grantRound: sql<number>`count(*) filter (where ${fundingPrograms.programType} = 'grant-round')`,
        fellowship: sql<number>`count(*) filter (where ${fundingPrograms.programType} = 'fellowship')`,
        prize: sql<number>`count(*) filter (where ${fundingPrograms.programType} = 'prize')`,
        solicitation: sql<number>`count(*) filter (where ${fundingPrograms.programType} = 'solicitation')`,
        call: sql<number>`count(*) filter (where ${fundingPrograms.programType} = 'call')`,
        open: sql<number>`count(*) filter (where ${fundingPrograms.status} = 'open')`,
        closed: sql<number>`count(*) filter (where ${fundingPrograms.status} = 'closed')`,
        awarded: sql<number>`count(*) filter (where ${fundingPrograms.status} = 'awarded')`,
      })
      .from(fundingPrograms);

    return c.json({
      total: statsRow.total,
      totalBudget: Number(statsRow.totalBudget),
      byType: {
        rfp: Number(statsRow.rfp),
        "grant-round": Number(statsRow.grantRound),
        fellowship: Number(statsRow.fellowship),
        prize: Number(statsRow.prize),
        solicitation: Number(statsRow.solicitation),
        call: Number(statsRow.call),
      },
      byStatus: {
        open: Number(statsRow.open),
        closed: Number(statsRow.closed),
        awarded: Number(statsRow.awarded),
      },
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { program_type, status, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [];
    if (program_type)
      conditions.push(eq(fundingPrograms.programType, program_type));
    if (status) conditions.push(eq(fundingPrograms.status, status));
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(fundingPrograms)
      .where(whereClause)
      .orderBy(desc(fundingPrograms.syncedAt), desc(fundingPrograms.id))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(fundingPrograms)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      fundingPrograms: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-org/:orgId ----
  .get("/by-org/:orgId", zv("query", ScopedQuery), async (c) => {
    const orgId = c.req.param("orgId");
    const { program_type, status, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [eq(fundingPrograms.orgId, orgId)];
    if (program_type)
      conditions.push(eq(fundingPrograms.programType, program_type));
    if (status) conditions.push(eq(fundingPrograms.status, status));
    const whereClause = and(...conditions);

    const rows = await db
      .select()
      .from(fundingPrograms)
      .where(whereClause)
      .orderBy(desc(fundingPrograms.syncedAt), desc(fundingPrograms.id))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(fundingPrograms)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      orgId,
      fundingPrograms: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-division/:divisionId ----
  .get(
    "/by-division/:divisionId",
    zv("query", ScopedQuery),
    async (c) => {
      const divisionId = c.req.param("divisionId");
      const { program_type, status, limit, offset } = c.req.valid("query");
      const db = getDrizzleDb();

      const conditions = [eq(fundingPrograms.divisionId, divisionId)];
      if (program_type)
        conditions.push(eq(fundingPrograms.programType, program_type));
      if (status) conditions.push(eq(fundingPrograms.status, status));
      const whereClause = and(...conditions);

      const rows = await db
        .select()
        .from(fundingPrograms)
        .where(whereClause)
        .orderBy(desc(fundingPrograms.syncedAt), desc(fundingPrograms.id))
        .limit(limit)
        .offset(offset);

      const countResult = await db
        .select({ count: count() })
        .from(fundingPrograms)
        .where(whereClause);
      const total = countResult[0].count;

      return c.json({
        divisionId,
        fundingPrograms: rows.map(formatRow),
        total,
        limit,
        offset,
      });
    }
  )

  // ---- GET /:id ----
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(fundingPrograms)
      .where(eq(fundingPrograms.id, id))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `Funding program ${id} not found`);
    }

    return c.json(formatRow(rows[0]));
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncFundingProgramsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
        id: item.id,
        orgId: item.orgId,
        divisionId: item.divisionId ?? null,
        name: item.name,
        description: item.description ?? null,
        programType: item.programType,
        totalBudget: item.totalBudget != null ? String(item.totalBudget) : null,
        currency: item.currency,
        applicationUrl: item.applicationUrl ?? null,
        openDate: item.openDate ?? null,
        deadline: item.deadline ?? null,
        status: item.status ?? null,
        source: item.source ?? null,
        notes: item.notes ?? null,
      }));

      await tx
        .insert(fundingPrograms)
        .values(allVals)
        .onConflictDoUpdate({
          target: fundingPrograms.id,
          set: {
            orgId: sql`excluded.org_id`,
            name: sql`excluded.name`,
            programType: sql`excluded.program_type`,
            currency: sql`excluded.currency`,
            // COALESCE: preserve existing values when sync payload sends null.
            // To clear a protected field, use a dedicated endpoint (not sync).
            divisionId: sql`COALESCE(excluded.division_id, ${fundingPrograms.divisionId})`,
            description: sql`COALESCE(excluded.description, ${fundingPrograms.description})`,
            totalBudget: sql`COALESCE(excluded.total_budget, ${fundingPrograms.totalBudget})`,
            applicationUrl: sql`COALESCE(excluded.application_url, ${fundingPrograms.applicationUrl})`,
            openDate: sql`COALESCE(excluded.open_date, ${fundingPrograms.openDate})`,
            deadline: sql`COALESCE(excluded.deadline, ${fundingPrograms.deadline})`,
            status: sql`COALESCE(excluded.status, ${fundingPrograms.status})`,
            source: sql`COALESCE(excluded.source, ${fundingPrograms.source})`,
            notes: sql`COALESCE(excluded.notes, ${fundingPrograms.notes})`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const fundingProgramsRoute = fundingProgramsApp;
export type FundingProgramsRoute = typeof fundingProgramsApp;
