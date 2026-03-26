import { Hono } from "hono";
import { z } from "zod";
import { eq, and, or, count, sql, desc, isNull, like, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { personnel, entities } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "../shared/utils.js";
import { upsertThingsInTx } from "../shared/thing-sync.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
import { resolveEntityId, type ResolvedEntityVars } from "../shared/resolve-entity-middleware.js";
import { formatEntityRef } from "../shared/entity-ref.js";
import { logAuditEntries } from "./audit-log.js";

// ---- Helpers: SQL ----

/**
 * Build a parameterized SQL value list for use with `IN (...)`.
 * See entities.ts for full docs on why ANY() doesn't work with Drizzle sql tag.
 */
function sqlInList(values: string[]) {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

// ---- Constants ----

const MAX_PAGE_SIZE = 200;
const VALID_ROLE_TYPES = ["key-person", "board", "career"] as const;

/** Matches stableIds: exactly 10 alphanumeric chars with at least one uppercase letter. */
const STABLE_ID_PATTERN = /^(?=.*[A-Z])[A-Za-z0-9]{10}$/;

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

/** Clean a raw personId for display: strip "new:" prefix, hide bare stableIds. */
function cleanPersonId(pid: string): string | null {
  if (pid.startsWith("new:")) return pid.slice(4).trim();
  if (STABLE_ID_PATTERN.test(pid)) return null;
  return pid;
}

const personEntity = alias(entities, "person_entity");
const orgEntity = alias(entities, "org_entity");

/** Selection shape for personnel + joined entity titles + slugs. */
const joinedSelect = {
  personnel: personnel,
  personTitle: personEntity.title,
  personSlug: personEntity.id,
  orgTitle: orgEntity.title,
  orgSlug: orgEntity.id,
};

interface JoinedRow {
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

    const rows = await db
      .select(joinedSelect)
      .from(personnel)
      .leftJoin(personEntity, eq(personnel.personEntityId, personEntity.stableId))
      .leftJoin(orgEntity, eq(personnel.orgEntityId, orgEntity.stableId))
      .where(
        or(
          isNull(personnel.personEntityId),
          like(personnel.personId, "new:%"),
        )
      )
      .orderBy(personnel.organizationId, personnel.personId);

    const classified = rows.map((r) => {
      const p = r.personnel;
      let issueType: string;
      if (p.personId.startsWith("new:")) {
        issueType = "new-prefix";
      } else if (STABLE_ID_PATTERN.test(p.personId)) {
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
      total: classified.length,
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

    // Validate entity FK references before inserting
    const refError = await validateEntityRefs(c, db, [
      { fieldName: "personId", ids: items.map((i) => i.personId) },
      { fieldName: "organizationId", ids: items.map((i) => i.organizationId) },
    ]);
    if (refError) return refError;

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
      // NOTE: Use IN (sqlInList()) not ANY() — Drizzle expands JS arrays as
      // value-lists which breaks ANY() (see entities.ts sqlInList docs).
      const syncedIds = items.map((i) => i.id);
      const idList = sqlInList(syncedIds);
      await tx.execute(sql`
        UPDATE personnel p SET person_entity_id = e.stable_id
        FROM entities e
        WHERE (e.stable_id = p.person_id OR e.id = p.person_id)
          AND e.entity_type = 'person'
          AND p.person_entity_id IS NULL
          AND p.person_id NOT LIKE 'new:%'
          AND p.id IN (${idList})
      `);
      await tx.execute(sql`
        UPDATE personnel p SET org_entity_id = e.stable_id
        FROM entities e
        WHERE (e.stable_id = p.organization_id OR e.id = p.organization_id)
          AND e.entity_type = 'organization'
          AND p.org_entity_id IS NULL
          AND p.id IN (${idList})
      `);
      // Backfill display names for new: prefix and unresolved personIds
      await tx.execute(sql`
        UPDATE personnel SET
          person_display_name = trim(substring(person_id FROM 5))
        WHERE person_id LIKE 'new:%'
          AND person_display_name IS NULL
          AND id IN (${idList})
      `);
      await tx.execute(sql`
        UPDATE personnel SET
          person_display_name = person_id
        WHERE person_entity_id IS NULL
          AND person_display_name IS NULL
          AND NOT (person_id ~ '^[A-Za-z0-9]{10}$' AND person_id ~ '[A-Z]')
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

      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const personnelRoute = personnelApp;
export type PersonnelRoute = typeof personnelApp;
