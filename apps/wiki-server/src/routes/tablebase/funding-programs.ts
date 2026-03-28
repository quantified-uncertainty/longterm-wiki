import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql, desc, inArray } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { fundingPrograms, things } from "../../schema.js";
import { logger } from "../../logger.js";
import {
  paginationQuery,
  noDuplicateIds,
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  zv,
} from "../shared/utils.js";
import { upsertThingsInTx, resolveEntityTitles } from "../shared/thing-sync.js";

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

    // Check for natural key collisions within the batch itself
    const batchKeys = new Set<string>();
    for (const item of items) {
      const key = `${item.orgId}::${item.name}`;
      if (batchKeys.has(key)) {
        return validationError(
          c,
          `Duplicate (orgId, name) in batch: orgId=${item.orgId}, name="${item.name}". ` +
          `Each funding program must have a unique name within its organization.`
        );
      }
      batchKeys.add(key);
    }

    // Check for natural key collisions with existing records (different IDs, same orgId+name).
    // The uq_fp_org_name unique index enforces this at the DB level, but checking here
    // gives a clear error message instead of a raw constraint violation.
    const existingConflicts = await db
      .select({ id: fundingPrograms.id, orgId: fundingPrograms.orgId, name: fundingPrograms.name })
      .from(fundingPrograms)
      .where(
        sql`(${fundingPrograms.orgId}, ${fundingPrograms.name}) IN (${sql.join(
          items.map(i => sql`(${i.orgId}, ${i.name})`),
          sql`, `
        )})`
      );

    const conflictById = new Map(existingConflicts.map(r => [`${r.orgId}::${r.name}`, r.id]));
    const naturalKeyConflicts: string[] = [];
    for (const item of items) {
      const existingId = conflictById.get(`${item.orgId}::${item.name}`);
      if (existingId && existingId !== item.id) {
        naturalKeyConflicts.push(
          `"${item.name}" (orgId=${item.orgId}): incoming id=${item.id} conflicts with existing id=${existingId}`
        );
      }
    }

    if (naturalKeyConflicts.length > 0) {
      return validationError(
        c,
        `Natural key conflict: ${naturalKeyConflicts.length} item(s) have the same (orgId, name) as existing records with different IDs. ` +
        `Use the existing ID to update, or delete the existing record first.\n` +
        naturalKeyConflicts.join("\n")
      );
    }

    let upserted = 0;

    try {
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
            // COALESCE: preserve existing values when sync payload sends null
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

      // Resolve org slugs to human-readable titles for search
      const orgSlugs = [...new Set(items.map((fp) => fp.orgId))];
      const titleMap = await resolveEntityTitles(tx, orgSlugs);

      // Dual-write to things table
      await upsertThingsInTx(
        tx,
        items.map((fp) => ({
          id: fp.id,
          thingType: "funding-program" as const,
          title: fp.name,
          sourceTable: "funding_programs",
          sourceId: fp.id,
          description: fp.description || null,
          sourceUrl: fp.source,
          parentTitle: titleMap.get(fp.orgId) ?? fp.orgId,
        }))
      );

      upserted = allVals.length;
    });
    } catch (err: unknown) {
      // Catch unique constraint violations from race conditions (concurrent insert
      // with same orgId+name but different id, between pre-check and INSERT).
      // The pre-check reduces this window but can't eliminate it.
      const pgError = err as { code?: string; constraint?: string };
      if (pgError.code === "23505" && pgError.constraint?.includes("uq_fp_org_name")) {
        return validationError(
          c,
          "A funding program with the same (orgId, name) was created concurrently. " +
          "Retry the request — the pre-check will now detect the conflict."
        );
      }
      throw err;
    }

    return c.json({ upserted });
  })

  // ---- POST /delete-batch ----
  // Delete funding programs by ID (for deduplication). Also removes corresponding things.
  .post("/delete-batch", async (c) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const parsed = z.object({
      ids: z.array(z.string().min(1).max(20)).min(1).max(100),
    }).safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { ids } = parsed.data;
    const db = getDrizzleDb();

    logger.info({ count: ids.length }, "Deleting funding programs batch");

    await db.transaction(async (tx) => {
      // Delete from things table first (FK-safe)
      await tx
        .delete(things)
        .where(
          and(
            eq(things.sourceTable, "funding_programs"),
            inArray(things.sourceId, ids),
          ),
        );

      // Delete the funding programs
      await tx
        .delete(fundingPrograms)
        .where(inArray(fundingPrograms.id, ids));
    });

    return c.json({ deleted: ids.length });
  });

// ---- Exports ----

export const fundingProgramsRoute = fundingProgramsApp;
export type FundingProgramsRoute = typeof fundingProgramsApp;
