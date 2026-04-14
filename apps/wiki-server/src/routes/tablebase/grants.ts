import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, sql, desc, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { logger } from "../../logger.js";
import { grants, things, entities, fundingPrograms, sourceVerdicts } from "../../schema.js";
import {
  verdictJoinCondition,
  verdictSelectFields,
  formatSourcing,
  fetchFieldVerdicts,
  type VerdictJoinFields,
} from "../shared/sourcing-join.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  noDuplicateIds,
  clampedLimit,
} from "../shared/utils.js";
import { parseSort, buildSearchCondition } from "../shared/query-helpers.js";
import { formatMoney } from "../shared/format-currency.js";
import { registerComposer, composeThing } from "../shared/compose-thing.js";
import { resolveEntityId, type ResolvedEntityVars } from "../shared/resolve-entity-middleware.js";
import { formatEntityRef } from "../shared/entity-ref.js";
import { InlineSourcingSchema } from "./sourcing-schema.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { shouldSkipEntityValidation } from "../shared/validate-entity-refs.js";
import { createSyncHandler } from "./sync-factory.js";

// ---- QUA-470 Phase 4b-B.1: grant composer ----
//
// Grant titles are authoritative (`g.name`). The description aggregates
// grantee, amount (currency-aware via formatMoney), and date.
interface GrantComposerRow {
  name: string;
  organizationId: string;
  granteeId?: string | null;
  amount?: number | string | null;
  currency?: string | null;
  date?: string | null;
}

registerComposer<GrantComposerRow>("grant", (row, titleMap) => ({
  title: row.name,
  description:
    [
      row.granteeId
        ? `to ${titleMap.get(row.granteeId) ?? row.granteeId}`
        : null,
      row.amount != null ? formatMoney(row.amount, row.currency) : null,
      row.date,
    ]
      .filter(Boolean)
      .join(", ") || null,
  parentTitle: titleMap.get(row.organizationId) ?? row.organizationId,
}));

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Query schemas ----

const SORT_ALLOWED = ["amount", "date", "name", "recipient"] as const;

const ByEntityQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().max(200).optional(),
  sort: z.string().max(50).optional(),
  status: z.string().max(50).optional(),
  amountMin: z.coerce.number().optional(),
  amountMax: z.coerce.number().optional(),
  program: z.string().max(200).optional(),
  /** Match entity as "funder" (organizationId, default) or "grantee" (granteeId). */
  role: z.enum(["funder", "grantee"]).default("funder"),
});

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
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
  dataSourceId: z.string().max(100).nullable().optional(),
  sourcing: InlineSourcingSchema.optional(),
  claimIds: z.array(z.number().int().positive()).optional(),
});

const SyncGrantsBatchSchema = z.object({
  items: z
    .array(SyncGrantItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
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

const granteeEntity = alias(entities, "grantee_entity");
const orgEntity = alias(entities, "org_entity");

/** Selection shape for grants + joined entity titles + slugs + verdicts. */
const joinedSelect = {
  grants: grants,
  granteeTitle: granteeEntity.title,
  granteeSlug: granteeEntity.id,
  orgTitle: orgEntity.title,
  orgSlug: orgEntity.id,
  ...verdictSelectFields,
};

interface JoinedRow extends VerdictJoinFields {
  grants: typeof grants.$inferSelect;
  granteeTitle: string | null;
  granteeSlug: string | null;
  orgTitle: string | null;
  orgSlug: string | null;
}

function formatRow(r: JoinedRow) {
  const g = r.grants;
  const granteeRef = formatEntityRef(g.granteeEntityId, r.granteeSlug, r.granteeTitle, g.granteeDisplayName, g.granteeId);
  const orgRef = formatEntityRef(g.orgEntityId, r.orgSlug, r.orgTitle, g.orgDisplayName, g.organizationId);
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
    dataSourceId: g.dataSourceId,
    // Structured entity refs (slug + name for frontend URL/display)
    grantee: granteeRef,
    organization: orgRef,
    // Legacy flat fields (for backward compat — use structured refs above in new code)
    granteeEntityId: g.granteeEntityId,
    granteeDisplayName: g.granteeDisplayName,
    granteeSlug: granteeRef.slug,
    granteeResolvedName: granteeRef.name,
    orgEntityId: g.orgEntityId,
    orgDisplayName: g.orgDisplayName,
    orgSlug: orgRef.slug,
    orgResolvedName: orgRef.name,
    syncedAt: g.syncedAt,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    sourcing: formatSourcing(r),
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

const grantsApp = new Hono<{ Variables: ResolvedEntityVars }>()

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
      .leftJoin(sourceVerdicts, verdictJoinCondition("grant", grants.id))
      .orderBy(desc(grants.syncedAt), grants.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(grants);
    const total = countResult[0].count;

    // Fetch per-field verdicts for all returned grants
    const grantIds = rows.map((r) => r.grants.id);
    const fieldVerdictsMap = await fetchFieldVerdicts(db, "grant", grantIds);

    return c.json({
      grants: rows.map((r) => ({
        ...formatRow(r),
        fieldVerdicts: fieldVerdictsMap[r.grants.id] ?? {},
      })),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-entity/:entityId ----
  // Supports server-side search (?q=), sort (?sort=amount:desc),
  // and filters (?status=, ?amountMin=, ?amountMax=, ?program=).
  .get("/by-entity/:entityId", resolveEntityId(), zv("query", ByEntityQuery), async (c) => {
    const resolvedId = c.get("resolvedEntityId");
    const { limit, offset, q, sort, status, amountMin, amountMax, program, role } =
      c.req.valid("query");
    const db = getDrizzleDb();

    // Build WHERE conditions — match on funder or grantee based on role param
    const entityCol = role === "grantee" ? grants.granteeId : grants.organizationId;
    const conditions: SQL[] = [eq(entityCol, resolvedId)];

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
      .leftJoin(sourceVerdicts, verdictJoinCondition("grant", grants.id))
      .where(where)
      .orderBy(orderClause, grants.id)
      .limit(limit)
      .offset(offset);

    // Fetch per-field verdicts for all returned grants
    const grantIds = rows.map((r) => r.grants.id);
    const fieldVerdictsMap = await fetchFieldVerdicts(db, "grant", grantIds);

    return c.json({
      entityId: resolvedId,
      grants: rows.map((r) => ({
        ...formatRow(r),
        fieldVerdicts: fieldVerdictsMap[r.grants.id] ?? {},
      })),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-org-summary ----
  .get("/by-org-summary", async (c) => {
    const db = getDrizzleDb();
    const LIMIT = 50;

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
      .orderBy(sql`coalesce(sum(${grants.amount}), 0) desc`)
      .limit(LIMIT);

    return c.json({
      organizations: rows.map((r) => ({
        organizationId: r.organizationId,
        grantCount: r.grantCount,
        totalAmount: Number(r.totalAmount),
        minDate: r.minDate,
        maxDate: r.maxDate,
      })),
      truncated: rows.length >= LIMIT,
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

    // Validate programId references (skip if requested via shouldSkipEntityValidation)
    if (!shouldSkipEntityValidation(c)) {
      const programIds = items.map((item) => item.programId);
      const invalid = await findInvalidProgramIds(db, programIds);
      if (invalid.length > 0) {
        // skipEntityValidation-ok: error message tells callers how to bypass after providing a reason
        const msg = `programId references not found in funding_programs: ${invalid.join(", ")}. Use ?skipEntityValidation=true&skipEntityValidationReason=<why> to bypass.`;
        return validationError(c, msg);
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
        programId: grants.programId,
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
        programId: r.programId ?? null,
      })),
      total: rows.length,
      truncated: rows.length >= HARD_LIMIT,
    });
  })

  // ---- POST /sync — uses sync-factory ----
  .post(
    "/sync",
    createSyncHandler({
      name: "grants",
      table: grants,
      batchSchema: SyncGrantsBatchSchema,
      enforceSourcing: true,
      naturalKey: (item) => `${item.organizationId}::${item.name}`,
      naturalKeyError:
        "Duplicate (organizationId, name) in batch — each grant must have a unique name within its organization",
      // granteeId is a LEGACY field that can hold either an entity ID or a
      // display name string (grant-import falls back to granteeName when no
      // entity match is found). Validating it would reject ~thousands of
      // grants with display-name granteeIds. The real entity FK is
      // granteeEntityId, which is validated by resolveEntityFKs downstream.
      entityRefs: ["organizationId"],
      // Validate programId against funding_programs (non-entities FK).
      // Bypassable via ?skipEntityValidation=true&skipEntityValidationReason=<why>.
      preValidate: async (c, db, items) => {
        if (shouldSkipEntityValidation(c)) return null;
        const programIds = items
          .map((item) => item.programId)
          .filter((id): id is string => id != null);
        const invalid = await findInvalidProgramIds(db, programIds);
        if (invalid.length > 0) {
          // skipEntityValidation-ok: error message tells callers how to bypass after providing a reason
          const msg = `programId references not found in funding_programs: ${invalid.join(", ")}. Use ?skipEntityValidation=true&skipEntityValidationReason=<why> to bypass.`;
          return validationError(c, msg);
        }
        return null;
      },
      toRow: (item, now) => ({
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
        dataSourceId: item.dataSourceId ?? null,
        syncedAt: now,
        updatedAt: now,
      }),
      auditRecordType: "grants",
      fkResolve: {
        tableName: "grants",
        fields: [
          { rawIdColumn: "organization_id", entityIdColumn: "org_entity_id", displayNameColumn: "org_display_name", entityTypeFilter: "organization" },
          { rawIdColumn: "grantee_id", entityIdColumn: "grantee_entity_id", displayNameColumn: "grantee_display_name" },
        ],
      },
      thingsTitleIds: (items) => [
        ...new Set([
          ...items.map((g) => g.organizationId),
          ...items
            .map((g) => g.granteeId)
            .filter((id): id is string => id != null),
        ]),
      ],
      // QUA-470: dispatch through the registered "grant" composer.
      toThing: (item, titleMap) => {
        const composed = composeThing<GrantComposerRow>("grant", item, titleMap);
        return {
          id: item.id,
          thingType: "grant" as const,
          title: composed.title,
          description: composed.description,
          parentTitle: composed.parentTitle,
          sourceTable: "grants",
          sourceId: item.id,
          sourceUrl: item.source ?? null,
        };
      },
      toVerdict: (item) => ({
        recordType: "grant",
        recordId: item.id,
        entityId: item.organizationId,
        sourceUrl: item.source ?? null,
        sourcing: item.sourcing ?? null,
      }),
      claimSupport: {
        recordType: "grants",
        getClaimIds: (item) => item.claimIds ?? [],
      },
    }),
  )

  .post("/delete-batch", deleteBatchHandler(grants, "grants"));

// ---- Exports ----

export const grantsRoute = grantsApp;
export type GrantsRoute = typeof grantsApp;
