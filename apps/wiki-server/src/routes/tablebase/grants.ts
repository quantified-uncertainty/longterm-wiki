import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql, desc, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { logger } from "../../logger.js";
import { grants, things, entities, fundingPrograms } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "../shared/utils.js";
import { parseSort, buildSearchCondition } from "../shared/query-helpers.js";
import { upsertThingsInTx, resolveEntityTitles } from "../shared/thing-sync.js";

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

/** Matches stableIds: exactly 10 alphanumeric chars with at least one uppercase letter. */
const STABLE_ID_PATTERN = /^(?=.*[A-Z])[A-Za-z0-9]{10}$/;

const granteeEntity = alias(entities, "grantee_entity");
const orgEntity = alias(entities, "org_entity");

/** Selection shape for grants + joined entity titles. */
const joinedSelect = {
  grants: grants,
  granteeTitle: granteeEntity.title,
  orgTitle: orgEntity.title,
};

interface JoinedRow {
  grants: typeof grants.$inferSelect;
  granteeTitle: string | null;
  orgTitle: string | null;
}

function cleanGranteeId(gid: string | null): string | null {
  if (!gid) return null;
  if (STABLE_ID_PATTERN.test(gid)) return null;
  return gid;
}

function cleanOrgId(oid: string): string | null {
  if (STABLE_ID_PATTERN.test(oid)) return null;
  return oid;
}

function formatRow(r: JoinedRow) {
  const g = r.grants;
  return {
    id: g.id,
    organizationId: g.organizationId,
    granteeId: g.granteeId,
    name: g.name,
    amount: g.amount != null ? Number(g.amount) : null,
    currency: g.currency,
    period: g.period,
    date: g.date,
    status: g.status,
    source: g.source,
    notes: g.notes,
    programId: g.programId,
    granteeEntityId: g.granteeEntityId,
    granteeDisplayName: g.granteeDisplayName,
    orgEntityId: g.orgEntityId,
    orgDisplayName: g.orgDisplayName,
    // Resolved names — prefer entity title, then display name, then cleaned ID
    granteeResolvedName: r.granteeTitle ?? g.granteeDisplayName ?? cleanGranteeId(g.granteeId),
    orgResolvedName: r.orgTitle ?? g.orgDisplayName ?? cleanOrgId(g.organizationId),
    syncedAt: g.syncedAt,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

/**
 * Validate that all non-null programIds exist in the funding_programs table.
 * Returns the list of invalid programIds, or an empty array if all are valid.
 */
async function findInvalidProgramIds(
  db: ReturnType<typeof getDrizzleDb>,
  programIds: string[],
): Promise<string[]> {
  const uniqueIds = [...new Set(programIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const rows = await db
    .select({ id: fundingPrograms.id })
    .from(fundingPrograms)
    .where(inArray(fundingPrograms.id, uniqueIds));

  const found = new Set(rows.map((r) => r.id));
  return uniqueIds.filter((id) => !found.has(id));
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
      .select(joinedSelect)
      .from(grants)
      .leftJoin(granteeEntity, eq(grants.granteeEntityId, granteeEntity.stableId))
      .leftJoin(orgEntity, eq(grants.orgEntityId, orgEntity.stableId))
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
      const searchCond = buildSearchCondition(
        [grants.name, grants.notes, grants.granteeId, grants.programId],
        q,
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
      .select(joinedSelect)
      .from(grants)
      .leftJoin(granteeEntity, eq(grants.granteeEntityId, granteeEntity.stableId))
      .leftJoin(orgEntity, eq(grants.orgEntityId, orgEntity.stableId))
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
    const HARD_LIMIT = 10000;
    const db = getDrizzleDb();

    const rows = await db
      .select({
        id: grants.id,
        granteeId: grants.granteeId,
        name: grants.name,
      })
      .from(grants)
      .limit(HARD_LIMIT);

    return c.json({
      grants: rows.map((r) => ({
        id: r.id,
        granteeId: r.granteeId,
        name: r.name,
      })),
      total: rows.length,
      truncated: rows.length >= HARD_LIMIT,
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

    logger.info(`batch-update-grantee: updating ${items.length} grants`);

    // Build bulk UPDATE using VALUES pattern instead of sequential per-row updates
    const valuesList = items
      .map((item) => sql`(${item.id}, ${item.granteeId})`)
      .reduce((acc, val, i) => (i === 0 ? val : sql`${acc}, ${val}`));

    const grantIds = items.map((item) => item.id);
    const thingIdList = sql.join(
      grantIds.map((id) => sql`${id}`),
      sql`, `,
    );

    const result = await db.transaction(async (tx) => {
      const res = await tx.execute(sql`
        UPDATE grants SET grantee_id = v.grantee_id, updated_at = now()
        FROM (VALUES ${valuesList}) AS v(id, grantee_id)
        WHERE grants.id = v.id
      `);

      // Touch things.updatedAt for affected grants
      await tx.execute(sql`
        UPDATE things SET updated_at = now()
        WHERE source_table = 'grants' AND source_id IN (${thingIdList})
      `);

      return res;
    });

    // db.execute returns rowCount at runtime (postgres.js) but it's not in Drizzle's type
    const updated = "rowCount" in result ? Number(result.rowCount) : items.length;

    return c.json({ updated });
  })

  // ---- GET /all-program-ids ----
  // Returns all grant IDs with their current programId, organizationId,
  // source, name, and notes. Used by backfill-program-ids to match grants
  // to funding programs.
  .get("/all-program-ids", async (c) => {
    const HARD_LIMIT = 10000;
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
      .from(grants)
      .limit(HARD_LIMIT);

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
      truncated: rows.length >= HARD_LIMIT,
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

    // Validate programId references
    const skipValidation = c.req.query("skipEntityValidation") === "true";
    if (!skipValidation) {
      const programIds = items.map((item) => item.programId);
      const invalid = await findInvalidProgramIds(db, programIds);
      if (invalid.length > 0) {
        return validationError(
          c,
          `programId references not found in funding_programs: ${invalid.join(", ")}. ` +
          `Use ?skipEntityValidation=true to bypass.`,
        );
      }
    }

    logger.info(`batch-update-program: updating ${items.length} grants`);

    // Build bulk UPDATE using VALUES pattern instead of sequential per-row updates
    const valuesList = items
      .map((item) => sql`(${item.id}, ${item.programId})`)
      .reduce((acc, val, i) => (i === 0 ? val : sql`${acc}, ${val}`));

    const grantIds = items.map((item) => item.id);
    const thingIdList = sql.join(
      grantIds.map((id) => sql`${id}`),
      sql`, `
    );

    const result = await db.transaction(async (tx) => {
      const res = await tx.execute(sql`
        UPDATE grants SET program_id = v.program_id, updated_at = now()
        FROM (VALUES ${valuesList}) AS v(id, program_id)
        WHERE grants.id = v.id
      `);

      // Touch things.updatedAt for affected grants
      await tx.execute(sql`
        UPDATE things SET updated_at = now()
        WHERE source_table = 'grants' AND source_id IN (${thingIdList})
      `);

      return res;
    });

    // db.execute returns rowCount at runtime (postgres.js) but it's not in Drizzle's type
    const updated = "rowCount" in result ? Number(result.rowCount) : items.length;

    return c.json({ updated });
  })

  // ---- GET /all-for-matching ----
  // Returns lightweight grant data for research area matching.
  .get("/all-for-matching", async (c) => {
    const HARD_LIMIT = 10000;
    const db = getDrizzleDb();

    const rows = await db
      .select({
        id: grants.id,
        name: grants.name,
        notes: grants.notes,
        amount: grants.amount,
        organizationId: grants.organizationId,
        granteeId: grants.granteeId,
      })
      .from(grants)
      .limit(HARD_LIMIT);

    return c.json({
      grants: rows.map((r) => ({
        id: r.id,
        name: r.name,
        notes: r.notes,
        amount: r.amount != null ? Number(r.amount) : null,
        organizationId: r.organizationId,
        granteeId: r.granteeId,
      })),
      total: rows.length,
      truncated: rows.length >= HARD_LIMIT,
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

    // Validate programId references (skip if skipEntityValidation is set)
    const skipValidation = c.req.query("skipEntityValidation") === "true";
    if (!skipValidation) {
      const programIds = items
        .map((item) => item.programId)
        .filter((id): id is string => id != null);
      const invalid = await findInvalidProgramIds(db, programIds);
      if (invalid.length > 0) {
        return validationError(
          c,
          `programId references not found in funding_programs: ${invalid.join(", ")}. ` +
          `Use ?skipEntityValidation=true to bypass.`,
        );
      }
    }

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

      // Resolve org + grantee slugs to human-readable titles for search
      const orgSlugs = [...new Set(items.map((g) => g.organizationId))];
      const granteeSlugs = items
        .map((g) => g.granteeId)
        .filter((id): id is string => id != null);
      const titleMap = await resolveEntityTitles(tx, [...orgSlugs, ...granteeSlugs]);

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
          parentTitle: titleMap.get(g.organizationId) ?? g.organizationId,
          description: [
            g.granteeId
              ? `to ${titleMap.get(g.granteeId) ?? g.granteeId}`
              : null,
            g.amount != null ? `$${Number(g.amount).toLocaleString()}` : null,
            g.date,
          ].filter(Boolean).join(", ") || null,
        }))
      );

      upserted = allVals.length;
    });

    return c.json({ upserted });
  })

  // ---- POST /delete-batch ----
  // Delete grants by ID (for deduplication). Also removes corresponding things.
  .post("/delete-batch", async (c) => {
    const raw = await parseJsonBody(c);
    if (!raw) return invalidJsonError(c);

    const parsed = z.object({
      ids: z.array(z.string().min(1).max(20)).min(1).max(500),
    }).safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { ids } = parsed.data;
    const db = getDrizzleDb();

    logger.info({ count: ids.length }, "Deleting grants batch");

    await db.transaction(async (tx) => {
      // Delete from things table first (FK-safe)
      await tx
        .delete(things)
        .where(
          and(
            eq(things.sourceTable, "grants"),
            inArray(things.sourceId, ids),
          ),
        );

      // Delete the grants
      await tx
        .delete(grants)
        .where(inArray(grants.id, ids));
    });

    return c.json({ deleted: ids.length });
  });

// ---- Exports ----

export const grantsRoute = grantsApp;
export type GrantsRoute = typeof grantsApp;
