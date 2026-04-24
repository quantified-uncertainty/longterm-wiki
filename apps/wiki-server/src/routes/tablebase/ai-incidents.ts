/**
 * ai-incidents — Phase 6 of QUA-687 (QUA-693).
 *
 * Mirrors the MIT AI Incident Database (AIID; CC-BY-SA 4.0). OECD AIM ingest
 * deferred to Phase 7 — see Linear QUA-693 for the Day-0 format-check result.
 *
 * The factory handles parse + upsert + FK backfill + things dual-write.
 * Natural key is `(source, source_incident_id)` so re-runs of the nightly
 * snapshot ingest are idempotent.
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { aiIncidents, aiIncidentReports, entities } from "../../schema.js";
import { zv, clampedLimit } from "../shared/utils.js";
import { buildSearchCondition } from "../shared/query-helpers.js";
import { formatEntityRef } from "../shared/entity-ref.js";
import { registerComposer, composeThing } from "../shared/compose-thing.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";

// ---- QUA-693: ai_incident composer ----
//
// Title: incident title verbatim. Description: short summary preview.
// parentTitle: deployer org > developer org > model — whichever has a
// resolved entity title. Falls back to null when no attribution.
interface AiIncidentComposerRow {
  title: string;
  summary: string;
  orgId?: string | null;
  developerOrgId?: string | null;
  aiModelId?: string | null;
}

registerComposer<AiIncidentComposerRow>("ai_incident", (row, titleMap) => {
  const parent =
    (row.orgId && titleMap.get(row.orgId)) ||
    (row.developerOrgId && titleMap.get(row.developerOrgId)) ||
    (row.aiModelId && titleMap.get(row.aiModelId)) ||
    null;
  return {
    title: row.title,
    description:
      row.summary.length > 300
        ? row.summary.slice(0, 297) + "..."
        : row.summary,
    parentTitle: parent,
  };
});

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

/**
 * Valid `source` values. CHECK-enforced at the DB layer. Expand here and in
 * the SQL constraint in lockstep when adding OECD AIM.
 */
const VALID_SOURCES = ["mit-aiid"] as const;

/**
 * Hard cap on the `summary` field. AIID `description` is usually ≤2 KB;
 * we cap at 4 KB to leave headroom without accidentally absorbing the full
 * report text. If an upstream field blows past this, the ingest truncates
 * with an ellipsis — intentional: the `full_report_url` is the authoritative
 * reading path.
 */
const MAX_SUMMARY_CHARS = 4000;

// ---- Query schemas ----

const SORT_ALLOWED = [
  "incidentDate",
  "reportedDate",
  "severity",
  "title",
] as const;

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
  /** Filter by source (e.g. "mit-aiid"). */
  source: z.string().max(16).optional(),
  /** Filter by severity (e.g. "high"). */
  severity: z.string().max(32).optional(),
  /** Text search across title/summary. */
  q: z.string().max(200).optional(),
  /** Filter by attributed org entity stableId. */
  orgId: z.string().max(20).optional(),
  /** Filter by attributed ai-model entity stableId. */
  aiModelId: z.string().max(20).optional(),
  /** Only include incidents with `incident_date >= this`. Useful to skip pre-2000 industrial-robot entries. */
  minIncidentDate: z.string().max(20).optional(),
  sort: z
    .enum(SORT_ALLOWED)
    .default("incidentDate"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

const ByEntityQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 50),
  offset: z.coerce.number().int().min(0).default(0),
  /** Which attribution column to match the entity on. */
  role: z.enum(["deployer", "developer", "model", "any"]).default("any"),
});

// ---- Sync schema ----

const SyncAiIncidentItemSchema = z.object({
  id: z.string().length(10),
  source: z.enum(VALID_SOURCES),
  sourceIncidentId: z.string().min(1).max(128),
  reportedDate: z.string().max(20).nullable().optional(),
  incidentDate: z.string().max(20).nullable().optional(),
  severity: z.string().max(32).nullable().optional(),
  upstreamSeverity: z.string().max(64).nullable().optional(),
  title: z.string().min(1).max(1000),
  summary: z.string().min(0).max(MAX_SUMMARY_CHARS),
  fullReportUrl: z.string().max(2000).nullable().optional(),
  aiModelId: z.string().max(20).nullable().optional(),
  orgId: z.string().max(20).nullable().optional(),
  developerOrgId: z.string().max(20).nullable().optional(),
  attributionConfidence: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .optional(),
  tags: z.array(z.string().max(64)).max(50).optional(),
  raw: z.record(z.string(), z.unknown()),
  upstreamFetchedAt: z.string().min(1).max(40),
  /** Optional: reports to upsert alongside the incident (replace-all semantics). */
  reports: z
    .array(
      z.object({
        url: z.string().min(1).max(2000),
        title: z.string().max(1000).nullable().optional(),
        publisher: z.string().max(500).nullable().optional(),
        publishedAt: z.string().max(20).nullable().optional(),
        language: z.string().max(8).nullable().optional(),
      }),
    )
    .max(500)
    .optional(),
});

type AiIncidentItem = z.infer<typeof SyncAiIncidentItemSchema>;

const SyncAiIncidentsBatchSchema = z.object({
  items: z.array(SyncAiIncidentItemSchema).min(1).max(200),
});

// ---- Formatting ----

const aiModelEntity = alias(entities, "ai_model_entity");
const orgEntityAlias = alias(entities, "org_entity");
const developerOrgEntity = alias(entities, "developer_org_entity");

interface JoinedRow {
  ai_incidents: typeof aiIncidents.$inferSelect;
  aiModelTitle: string | null;
  aiModelSlug: string | null;
  orgTitle: string | null;
  orgSlug: string | null;
  developerOrgTitle: string | null;
  developerOrgSlug: string | null;
}

const joinedSelect = {
  ai_incidents: aiIncidents,
  aiModelTitle: aiModelEntity.title,
  aiModelSlug: aiModelEntity.id,
  orgTitle: orgEntityAlias.title,
  orgSlug: orgEntityAlias.id,
  developerOrgTitle: developerOrgEntity.title,
  developerOrgSlug: developerOrgEntity.id,
};

function formatRow(r: JoinedRow) {
  const i = r.ai_incidents;
  return {
    id: i.id,
    source: i.source,
    sourceIncidentId: i.sourceIncidentId,
    reportedDate: i.reportedDate,
    incidentDate: i.incidentDate,
    severity: i.severity,
    upstreamSeverity: i.upstreamSeverity,
    title: i.title,
    summary: i.summary,
    fullReportUrl: i.fullReportUrl,
    aiModel: formatEntityRef(i.aiModelId, r.aiModelSlug, r.aiModelTitle, null, null),
    org: formatEntityRef(i.orgId, r.orgSlug, r.orgTitle, null, null),
    developerOrg: formatEntityRef(
      i.developerOrgId,
      r.developerOrgSlug,
      r.developerOrgTitle,
      null,
      null,
    ),
    attributionConfidence:
      i.attributionConfidence != null ? Number(i.attributionConfidence) : null,
    tags: i.tags,
    upstreamFetchedAt: i.upstreamFetchedAt,
    syncedAt: i.syncedAt,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const aiIncidentsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [totalsRow] = await db
      .select({
        total: count(),
        withOrg: sql<number>`count(*) filter (where ${aiIncidents.orgId} is not null)`,
        withModel: sql<number>`count(*) filter (where ${aiIncidents.aiModelId} is not null)`,
      })
      .from(aiIncidents);

    const bySource = await db
      .select({
        source: aiIncidents.source,
        total: count(),
      })
      .from(aiIncidents)
      .groupBy(aiIncidents.source);

    return c.json({
      total: totalsRow?.total ?? 0,
      withOrg: Number(totalsRow?.withOrg ?? 0),
      withModel: Number(totalsRow?.withModel ?? 0),
      bySource: bySource.map((r) => ({ source: r.source, total: r.total })),
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const {
      limit,
      offset,
      source,
      severity,
      q,
      orgId,
      aiModelId,
      minIncidentDate,
      sort,
      dir,
    } = c.req.valid("query");
    const db = getDrizzleDb();

    const conditions: SQL[] = [];
    if (source) conditions.push(eq(aiIncidents.source, source));
    if (severity) conditions.push(eq(aiIncidents.severity, severity));
    if (orgId) conditions.push(eq(aiIncidents.orgId, orgId));
    if (aiModelId) conditions.push(eq(aiIncidents.aiModelId, aiModelId));
    if (minIncidentDate) {
      conditions.push(sql`${aiIncidents.incidentDate} >= ${minIncidentDate}`);
    }
    if (q) {
      const searchCond = buildSearchCondition(
        [aiIncidents.title, aiIncidents.summary],
        q,
      );
      if (searchCond) conditions.push(searchCond);
    }

    const where =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? conditions[0]
          : and(...conditions);

    const sortColMap: Record<(typeof SORT_ALLOWED)[number], SQL> = {
      incidentDate: sql`${aiIncidents.incidentDate}`,
      reportedDate: sql`${aiIncidents.reportedDate}`,
      severity: sql`${aiIncidents.severity}`,
      title: sql`${aiIncidents.title}`,
    };
    const sortCol = sortColMap[sort];
    const orderClause =
      dir === "desc"
        ? sql`${sortCol} DESC NULLS LAST`
        : sql`${sortCol} ASC NULLS LAST`;

    const baseQuery = db
      .select(joinedSelect)
      .from(aiIncidents)
      .leftJoin(aiModelEntity, eq(aiIncidents.aiModelId, aiModelEntity.stableId))
      .leftJoin(orgEntityAlias, eq(aiIncidents.orgId, orgEntityAlias.stableId))
      .leftJoin(
        developerOrgEntity,
        eq(aiIncidents.developerOrgId, developerOrgEntity.stableId),
      );

    const rows = where
      ? await baseQuery
          .where(where)
          .orderBy(orderClause, aiIncidents.id)
          .limit(limit)
          .offset(offset)
      : await baseQuery
          .orderBy(orderClause, aiIncidents.id)
          .limit(limit)
          .offset(offset);

    const totalQuery = db.select({ total: count() }).from(aiIncidents);
    const [{ total }] = where
      ? await totalQuery.where(where)
      : await totalQuery;

    return c.json({
      incidents: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-entity/:entityId ----
  .get(
    "/by-entity/:entityId",
    zv("query", ByEntityQuery),
    async (c) => {
      const entityId = c.req.param("entityId");
      const { limit, offset, role } = c.req.valid("query");
      const db = getDrizzleDb();

      const conditions: SQL[] = [];
      switch (role) {
        case "deployer":
          conditions.push(eq(aiIncidents.orgId, entityId));
          break;
        case "developer":
          conditions.push(eq(aiIncidents.developerOrgId, entityId));
          break;
        case "model":
          conditions.push(eq(aiIncidents.aiModelId, entityId));
          break;
        case "any":
        default:
          conditions.push(
            sql`(${aiIncidents.orgId} = ${entityId} OR ${aiIncidents.developerOrgId} = ${entityId} OR ${aiIncidents.aiModelId} = ${entityId})`,
          );
      }
      const where = conditions[0];

      const rows = await db
        .select(joinedSelect)
        .from(aiIncidents)
        .leftJoin(
          aiModelEntity,
          eq(aiIncidents.aiModelId, aiModelEntity.stableId),
        )
        .leftJoin(
          orgEntityAlias,
          eq(aiIncidents.orgId, orgEntityAlias.stableId),
        )
        .leftJoin(
          developerOrgEntity,
          eq(aiIncidents.developerOrgId, developerOrgEntity.stableId),
        )
        .where(where)
        .orderBy(desc(aiIncidents.incidentDate), aiIncidents.id)
        .limit(limit)
        .offset(offset);

      const [{ total }] = await db
        .select({ total: count() })
        .from(aiIncidents)
        .where(where);

      return c.json({
        entityId,
        role,
        incidents: rows.map(formatRow),
        total,
        limit,
        offset,
      });
    },
  )

  // ---- GET /:id/reports ----
  .get("/:id/reports", async (c) => {
    const id = c.req.param("id");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(aiIncidentReports)
      .where(eq(aiIncidentReports.incidentId, id))
      .orderBy(desc(aiIncidentReports.publishedAt));

    return c.json({ incidentId: id, reports: rows });
  })

  // ---- POST /sync — uses sync-factory ----
  .post(
    "/sync",
    createSyncHandler({
      name: "ai-incidents",
      table: aiIncidents,
      batchSchema: SyncAiIncidentsBatchSchema,
      conflictTarget: [aiIncidents.source, aiIncidents.sourceIncidentId],
      naturalKey: (item: AiIncidentItem) =>
        `${item.source}::${item.sourceIncidentId}`,
      naturalKeyError:
        "Duplicate (source, sourceIncidentId) in batch — each upstream incident must appear at most once",
      toRow: (item: AiIncidentItem, now: Date) => ({
        id: item.id,
        source: item.source,
        sourceIncidentId: item.sourceIncidentId,
        reportedDate: item.reportedDate ?? null,
        incidentDate: item.incidentDate ?? null,
        severity: item.severity ?? null,
        upstreamSeverity: item.upstreamSeverity ?? null,
        title: item.title,
        summary: item.summary,
        fullReportUrl: item.fullReportUrl ?? null,
        aiModelId: item.aiModelId ?? null,
        orgId: item.orgId ?? null,
        developerOrgId: item.developerOrgId ?? null,
        attributionConfidence:
          item.attributionConfidence != null
            ? String(item.attributionConfidence)
            : null,
        tags: item.tags ?? [],
        raw: item.raw,
        upstreamFetchedAt: new Date(item.upstreamFetchedAt),
        syncedAt: now,
        updatedAt: now,
      }),
      auditRecordType: "ai_incidents",
      thingsTitleIds: (items: AiIncidentItem[]) => [
        ...new Set(
          items
            .flatMap((i) => [i.orgId, i.developerOrgId, i.aiModelId])
            .filter((id): id is string => id != null),
        ),
      ],
      toThing: (item: AiIncidentItem, titleMap: Map<string, string>) => {
        const composed = composeThing<AiIncidentComposerRow>(
          "ai_incident",
          item,
          titleMap,
        );
        return {
          id: item.id,
          thingType: "ai_incident",
          title: composed.title,
          description: composed.description,
          parentTitle: composed.parentTitle,
          sourceTable: "ai_incidents",
          sourceId: item.id,
          sourceUrl: item.fullReportUrl ?? null,
        };
      },
      // Reports upsert is "replace-all for this incident" — do it in the
      // same transaction so an ingest crash can't leave orphan rows.
      postUpsert: async (tx, items: AiIncidentItem[]) => {
        for (const item of items) {
          if (item.reports === undefined) continue;
          await tx
            .delete(aiIncidentReports)
            .where(eq(aiIncidentReports.incidentId, item.id));
          if (item.reports.length === 0) continue;
          await tx.insert(aiIncidentReports).values(
            item.reports.map((r) => ({
              incidentId: item.id,
              url: r.url,
              title: r.title ?? null,
              publisher: r.publisher ?? null,
              publishedAt: r.publishedAt ?? null,
              language: r.language ?? null,
            })),
          );
        }
      },
    }),
  )

  .post("/delete-batch", deleteBatchHandler(aiIncidents, "ai_incidents"));

// ---- Exports ----

export const aiIncidentsRoute = aiIncidentsApp;
export type AiIncidentsRoute = typeof aiIncidentsApp;
