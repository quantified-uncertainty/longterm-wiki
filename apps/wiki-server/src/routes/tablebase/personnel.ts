import { Hono } from "hono";
import { z } from "zod";
import { eq, and, or, count, sql, desc, isNull, like, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb, getDb } from "../../db.js";
import { logger } from "../../logger.js";
import { personnel, entities, things, sourceCheckVerdicts } from "../../schema.js";
import {
  verdictJoinCondition,
  verdictSelectFields,
  formatVerification,
  type VerdictJoinFields,
} from "../shared/verification-join.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  noDuplicateIds,
  clampedLimit,
} from "../shared/utils.js";
import { upsertThingsInTx } from "../shared/thing-sync.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
import { resolveEntityFKs } from "../shared/resolve-entity-fks.js";
import { resolveEntityId, type ResolvedEntityVars } from "../shared/resolve-entity-middleware.js";
import { formatEntityRef } from "../shared/entity-ref.js";
import { logAuditEntries } from "./audit-log.js";
import { InlineVerificationSchema } from "./verification-schema.js";
import { writeInlineVerdicts, logVerificationCoverage } from "./write-inline-verdicts.js";
import { validateClaimRefs, linkClaimsToRecords } from "../shared/validate-claims.js";
import { enforceVerification } from "../shared/verification-enforcement.js";
import { sqlInList } from "../shared/query-helpers.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const VALID_ROLE_TYPES = ["key-person", "board", "career"] as const;

import { isSid } from "@longterm-wiki/id-utils";

// ---- Query schemas ----

const ByEntityQuery = z.object({
  role_type: z.enum(VALID_ROLE_TYPES).optional(),
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

const ByPersonQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

const AllQuery = z.object({
  role_type: z.enum(VALID_ROLE_TYPES).optional(),
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schema ----

const SyncPersonnelItemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{10}$/, "id must be 10 alphanumeric characters (hyphens and underscores allowed)"),
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
  verification: InlineVerificationSchema.optional(),
  claimIds: z.array(z.number().int().positive()).optional(),
});

const SyncPersonnelBatchSchema = z.object({
  items: z
    .array(SyncPersonnelItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
});

// ---- Helpers ----

/** Clean a raw personId for display: strip "new:" prefix, hide bare stableIds. */
function cleanPersonId(pid: string): string | null {
  if (pid.startsWith("new:")) return pid.slice(4).trim();
  if (isSid(pid)) return null;
  return pid;
}

const personEntity = alias(entities, "person_entity");
const orgEntity = alias(entities, "org_entity");

/** Selection shape for personnel + joined entity titles + slugs + verdicts. */
const joinedSelect = {
  personnel: personnel,
  personTitle: personEntity.title,
  personSlug: personEntity.id,
  orgTitle: orgEntity.title,
  orgSlug: orgEntity.id,
  ...verdictSelectFields,
};

interface JoinedRow extends VerdictJoinFields {
  personnel: typeof personnel.$inferSelect;
  personTitle: string | null;
  personSlug: string | null;
  orgTitle: string | null;
  orgSlug: string | null;
}

function formatRow(r: JoinedRow) {
  const p = r.personnel;
  // Strip "new:" prefix for raw personId fallback
  const rawPersonId = p.personId.startsWith("new:") ? p.personId.slice(4).trim() : p.personId;
  const personRef = formatEntityRef(p.personEntityId, r.personSlug, r.personTitle, p.personDisplayName, rawPersonId);
  const orgRef = formatEntityRef(p.orgEntityId, r.orgSlug, r.orgTitle, p.orgDisplayName, p.organizationId);
  return {
    id: p.id,
    personId: p.personId,
    organizationId: p.organizationId,
    role: p.role,
    roleType: p.roleType,
    startDate: p.startDate,
    endDate: p.endDate,
    isFounder: p.isFounder,
    appointedBy: p.appointedBy,
    background: p.background,
    source: p.source,
    notes: p.notes,
    // Structured entity refs
    person: personRef,
    organization: orgRef,
    // Legacy flat fields (for backward compat)
    personEntityId: p.personEntityId,
    personDisplayName: p.personDisplayName,
    personResolvedName: personRef.name,
    orgEntityId: p.orgEntityId,
    orgDisplayName: p.orgDisplayName,
    orgResolvedName: orgRef.name,
    syncedAt: p.syncedAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    verification: formatVerification(r),
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const personnelApp = new Hono<{ Variables: ResolvedEntityVars }>()

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
      .select(joinedSelect)
      .from(personnel)
      .leftJoin(personEntity, eq(personnel.personEntityId, personEntity.stableId))
      .leftJoin(orgEntity, eq(personnel.orgEntityId, orgEntity.stableId))
      .leftJoin(sourceCheckVerdicts, verdictJoinCondition("personnel", personnel.id))
      .where(whereClause)
      .orderBy(desc(personnel.syncedAt), personnel.id)
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
  .get("/by-entity/:entityId", resolveEntityId(), zv("query", ByEntityQuery), async (c) => {
    const resolvedId = c.get("resolvedEntityId");
    const { role_type, limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions = [eq(personnel.organizationId, resolvedId)];
    if (role_type) conditions.push(eq(personnel.roleType, role_type));
    const whereClause = and(...conditions);

    const rows = await db
      .select(joinedSelect)
      .from(personnel)
      .leftJoin(personEntity, eq(personnel.personEntityId, personEntity.stableId))
      .leftJoin(orgEntity, eq(personnel.orgEntityId, orgEntity.stableId))
      .leftJoin(sourceCheckVerdicts, verdictJoinCondition("personnel", personnel.id))
      .where(whereClause)
      .orderBy(desc(personnel.syncedAt), personnel.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(personnel)
      .where(whereClause);
    const total = countResult[0].count;

    return c.json({
      entityId: resolvedId,
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
      .select(joinedSelect)
      .from(personnel)
      .leftJoin(personEntity, eq(personnel.personEntityId, personEntity.stableId))
      .leftJoin(orgEntity, eq(personnel.orgEntityId, orgEntity.stableId))
      .leftJoin(sourceCheckVerdicts, verdictJoinCondition("personnel", personnel.id))
      .where(eq(personnel.personId, personId))
      .orderBy(desc(personnel.syncedAt), personnel.id)
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

  // ---- GET /broken ----
  .get("/broken", async (c) => {
    const db = getDrizzleDb();
    const LIMIT = 100;

    const brokenCondition = or(
      isNull(personnel.personEntityId),
      like(personnel.personId, "new:%"),
    );

    const [rows, countResult] = await Promise.all([
      db
        .select(joinedSelect)
        .from(personnel)
        .leftJoin(personEntity, eq(personnel.personEntityId, personEntity.stableId))
        .leftJoin(orgEntity, eq(personnel.orgEntityId, orgEntity.stableId))
        .leftJoin(sourceCheckVerdicts, verdictJoinCondition("personnel", personnel.id))
        .where(brokenCondition)
        .orderBy(personnel.organizationId, personnel.personId)
        .limit(LIMIT),
      db
        .select({ count: count() })
        .from(personnel)
        .where(brokenCondition),
    ]);

    const total = countResult[0]?.count ?? 0;

    const classified = rows.map((r) => {
      const p = r.personnel;
      let issueType: string;
      if (p.personId.startsWith("new:")) {
        issueType = "new-prefix";
      } else if (isSid(p.personId)) {
        issueType = "unresolved-stableId";
      } else if (!p.personEntityId) {
        issueType = "no-entity-match";
      } else {
        issueType = "dangling-fk";
      }

      return {
        id: p.id,
        personId: p.personId,
        organizationId: p.organizationId,
        role: p.role,
        personEntityId: p.personEntityId,
        personDisplayName: p.personDisplayName,
        personResolvedName: r.personTitle ?? p.personDisplayName ?? cleanPersonId(p.personId),
        issueType,
      };
    });

    return c.json({
      total,
      truncated: rows.length >= LIMIT,
      byIssueType: {
        "new-prefix": classified.filter((r) => r.issueType === "new-prefix").length,
        "unresolved-stableId": classified.filter((r) => r.issueType === "unresolved-stableId").length,
        "no-entity-match": classified.filter((r) => r.issueType === "no-entity-match").length,
        "dangling-fk": classified.filter((r) => r.issueType === "dangling-fk").length,
      },
      records: classified,
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

    // Phase 5 (Discussion #3875): Verification enforcement — checks both server-side
    // config and client ?requireVerification=true param. See verification-enforcement.ts.
    const verificationError = enforceVerification(c, "personnel", items);
    if (verificationError) return verificationError;

    // Check for natural key collisions within the batch itself.
    // Natural key: (personId, organizationId, role, roleType)
    const batchKeys = new Set<string>();
    for (const item of items) {
      const key = `${item.personId}::${item.organizationId}::${item.role}::${item.roleType}`;
      if (batchKeys.has(key)) {
        return validationError(
          c,
          `Duplicate (personId, organizationId, role, roleType) in batch: ` +
          `personId=${item.personId}, organizationId=${item.organizationId}, ` +
          `role="${item.role}", roleType=${item.roleType}. ` +
          `Each personnel record must be unique by person + org + role.`
        );
      }
      batchKeys.add(key);
    }

    // Validate entity FK references before inserting
    const refError = await validateEntityRefs(c, db, [
      { fieldName: "personId", ids: items.map((i) => i.personId) },
      { fieldName: "organizationId", ids: items.map((i) => i.organizationId) },
    ]);
    if (refError) return refError;

    // Validate claim references (if any records cite verified claims)
    const allClaimIds = items.flatMap((i) => i.claimIds ?? []);
    if (allClaimIds.length > 0) {
      const rawDb = getDb();
      const claimError = await validateClaimRefs(rawDb, allClaimIds);
      if (claimError) return validationError(c, claimError);
    }

    let upserted = 0;
    let verdictsResult = { written: 0 };

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

      // Fetch existing records for audit log (before upsert)
      const existingIds = items.map((i) => i.id);
      const existing = await tx
        .select()
        .from(personnel)
        .where(inArray(personnel.id, existingIds));
      const existingMap = new Map(existing.map((r) => [r.id, r]));

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

      // Audit log
      await logAuditEntries(
        tx,
        allVals.map((v) => {
          const old = existingMap.get(v.id);
          return {
            recordType: "personnel",
            recordId: v.id,
            operation: old ? ("update" as const) : ("insert" as const),
            oldData: old ? { ...old } : null,
            newData: { ...v },
            sourceUrl: v.source ?? null,
          };
        })
      );

      // Post-sync: resolve entity FKs for newly synced rows
      const syncedIds = items.map((i) => i.id);
      await resolveEntityFKs(tx, {
        tableName: "personnel",
        fields: [
          { rawIdColumn: "person_id", entityIdColumn: "person_entity_id", displayNameColumn: "person_display_name", entityTypeFilter: "person" },
          { rawIdColumn: "organization_id", entityIdColumn: "org_entity_id", displayNameColumn: "org_display_name", entityTypeFilter: "organization" },
        ],
        scopeIds: syncedIds,
      });

      // Special handling: backfill display name from "new:" prefix (strip prefix)
      const idList = sqlInList(syncedIds);
      await tx.execute(sql`
        UPDATE personnel SET
          person_display_name = trim(substring(person_id FROM 5))
        WHERE person_id LIKE 'new:%'
          AND person_display_name IS NULL
          AND id IN (${idList})
      `);

      // Dual-write to things table with resolved names
      const resolvedItems = await tx
        .select({
          id: personnel.id,
          personId: personnel.personId,
          personDisplayName: personnel.personDisplayName,
          personEntityId: personnel.personEntityId,
          role: personnel.role,
          organizationId: personnel.organizationId,
          source: personnel.source,
        })
        .from(personnel)
        .where(inArray(personnel.id, syncedIds));

      // Build a map of stableId -> title for resolved person entities
      const resolvedPersonIds = resolvedItems
        .filter((r) => r.personEntityId)
        .map((r) => r.personEntityId!);
      let personTitleMap = new Map<string, string>();
      if (resolvedPersonIds.length > 0) {
        const personEntities = await tx
          .select({ stableId: entities.stableId, title: entities.title })
          .from(entities)
          .where(inArray(entities.stableId, resolvedPersonIds));
        personTitleMap = new Map(
          personEntities
            .filter((e) => e.stableId)
            .map((e) => [e.stableId!, e.title])
        );
      }

      await upsertThingsInTx(
        tx,
        resolvedItems.map((p) => {
          const personName = (p.personEntityId ? personTitleMap.get(p.personEntityId) : null)
            ?? p.personDisplayName
            ?? cleanPersonId(p.personId)
            ?? p.personId;
          return {
            id: p.id,
            thingType: "personnel" as const,
            title: `${personName} — ${p.role} at ${p.organizationId}`,
            sourceTable: "personnel",
            sourceId: p.id,
            sourceUrl: p.source,
          };
        })
      );

      // Write inline verification verdicts atomically within the same transaction
      verdictsResult = await writeInlineVerdicts(
        tx,
        items.map((item) => ({
          recordType: "personnel",
          recordId: item.id,
          entityId: item.organizationId,
          sourceUrl: item.source ?? null,
          verification: item.verification ?? null,
        }))
      );

      upserted = allVals.length;
    });

    logVerificationCoverage("personnel/sync", items.length, verdictsResult.written);

    // Link verified claims to records (best-effort — records already committed)
    let claimsLinked = 0;
    if (allClaimIds.length > 0) {
      try {
        const rawDb = getDb();
        const linkResult = await linkClaimsToRecords(rawDb, items.map((item) => ({
          recordId: item.id,
          recordType: "personnel",
          claimIds: item.claimIds,
        })));
        claimsLinked = linkResult.linked;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn({ error: msg }, "claim linking failed (records already committed)");
      }
    }

    return c.json({ upserted, verdictsWritten: verdictsResult.written, claimsLinked });
  })

  // ---- POST /delete ----
  .post("/delete", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = z
      .object({
        ids: z.array(z.string().min(1).max(20)).min(1).max(500),
        reason: z.string().min(1).max(500),
      })
      .safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { ids, reason } = parsed.data;
    const db = getDrizzleDb();

    let deleted = 0;

    await db.transaction(async (tx) => {
      // Fetch records before deletion for audit log
      const idList = sqlInList(ids);
      const existing = await tx
        .select()
        .from(personnel)
        .where(sql`${personnel.id} IN (${idList})`);

      if (existing.length === 0) {
        return;
      }

      // Audit log the deletions
      await logAuditEntries(
        tx,
        existing.map((row) => ({
          recordType: "personnel",
          recordId: row.id,
          operation: "delete" as const,
          oldData: { ...row },
          newData: { reason },
          sourceUrl: null,
        }))
      );

      // Delete from things table first (FK-safe)
      await tx
        .delete(things)
        .where(
          and(
            eq(things.sourceTable, "personnel"),
            sql`${things.sourceId} IN (${idList})`
          )
        );

      // Delete personnel records
      const result = await tx
        .delete(personnel)
        .where(sql`${personnel.id} IN (${idList})`)
        .returning({ id: personnel.id });

      deleted = result.length;
    });

    return c.json({ deleted, reason });
  });

// ---- Exports ----

export const personnelRoute = personnelApp;
export type PersonnelRoute = typeof personnelApp;
