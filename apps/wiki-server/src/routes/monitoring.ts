import { Hono } from "hono";
import { eq, desc, and, count, gte } from "drizzle-orm";
import { getDrizzleDb, getDb } from "../db.js";
import {
  serviceHealthIncidents,
  activeAgents,
  groundskeeperRuns,
  jobs,
} from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  firstOrThrow,
} from "./utils.js";
import {
  RecordIncidentSchema,
  UpdateIncidentSchema,
} from "../api-types.js";
import { logger } from "../logger.js";

// Static service registry — no DB table needed
const SERVICES = [
  "wiki-server",
  "groundskeeper",
  "discord-bot",
  "vercel-frontend",
  "github-actions",
] as const;

const monitoringApp = new Hono()
  // ---- GET /status — aggregated system health ----
  .get("/status", async (c) => {
    const db = getDrizzleDb();
    const rawDb = getDb();

    // 1. Wiki-server self-check (DB connectivity + counts)
    let wikiServerStatus: "healthy" | "degraded" | "down" = "healthy";
    let dbCounts = { pages: 0, entities: 0, facts: 0 };
    try {
      const countsResult = await rawDb`
        SELECT
          (SELECT count(*) FROM wiki_pages)::int as pages,
          (SELECT count(*) FROM entities)::int as entities,
          (SELECT count(*) FROM facts)::int as facts
      `;
      const row = countsResult[0] as {
        pages: number;
        entities: number;
        facts: number;
      };
      dbCounts = {
        pages: row.pages,
        entities: row.entities,
        facts: row.facts,
      };
    } catch {
      wikiServerStatus = "down";
    }

    // 2. Groundskeeper — check last heartbeat from active_agents
    const groundskeeperRows = await db
      .select({
        heartbeatAt: activeAgents.heartbeatAt,
        status: activeAgents.status,
      })
      .from(activeAgents)
      .where(eq(activeAgents.sessionId, "groundskeeper"))
      .limit(1);

    const gkAgent = groundskeeperRows[0];
    let groundskeeperStatus: "healthy" | "degraded" | "down" | "unknown" =
      "unknown";
    if (gkAgent) {
      const minutesSinceHeartbeat =
        (Date.now() - new Date(gkAgent.heartbeatAt).getTime()) / 60_000;
      groundskeeperStatus =
        minutesSinceHeartbeat < 10
          ? "healthy"
          : minutesSinceHeartbeat < 30
            ? "degraded"
            : "down";
    }

    // 3. Last groundskeeper health-check run
    const lastHealthCheckRows = await db
      .select()
      .from(groundskeeperRuns)
      .where(eq(groundskeeperRuns.taskName, "health-check"))
      .orderBy(desc(groundskeeperRuns.timestamp))
      .limit(1);

    // 4. Open incidents per service
    const openIncidents = await db
      .select({
        service: serviceHealthIncidents.service,
        count: count(),
      })
      .from(serviceHealthIncidents)
      .where(eq(serviceHealthIncidents.status, "open"))
      .groupBy(serviceHealthIncidents.service);

    const incidentMap = new Map(
      openIncidents.map((r) => [r.service, r.count])
    );

    // 5. Recent incidents (last 24h)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentIncidents = await db
      .select()
      .from(serviceHealthIncidents)
      .where(gte(serviceHealthIncidents.detectedAt, since))
      .orderBy(desc(serviceHealthIncidents.detectedAt))
      .limit(20);

    // 6. Jobs queue health
    const jobStats = await db
      .select({
        status: jobs.status,
        count: count(),
      })
      .from(jobs)
      .groupBy(jobs.status);

    // 7. Active agents count
    const agentCountResult = await db
      .select({ count: count() })
      .from(activeAgents)
      .where(eq(activeAgents.status, "active"));

    // Build service statuses
    const services = SERVICES.map((name) => {
      let status: "healthy" | "degraded" | "down" | "unknown";
      if (name === "wiki-server") {
        status = wikiServerStatus;
      } else if (name === "groundskeeper") {
        status = groundskeeperStatus;
      } else {
        // discord-bot, vercel-frontend, github-actions — inferred from open incidents
        const hasCritical = recentIncidents.some(
          (i) =>
            i.service === name &&
            i.severity === "critical" &&
            i.status === "open"
        );
        const openCount = incidentMap.get(name) ?? 0;
        status = hasCritical
          ? "down"
          : openCount > 0
            ? "degraded"
            : "unknown";
      }

      return {
        name,
        status,
        openIncidents: incidentMap.get(name) ?? 0,
      };
    });

    const overallStatus = services.some((s) => s.status === "down")
      ? "down"
      : services.some((s) => s.status === "degraded")
        ? "degraded"
        : "healthy";

    return c.json({
      overall: overallStatus as string,
      checkedAt: new Date().toISOString(),
      services,
      dbCounts,
      lastHealthCheck: (lastHealthCheckRows[0] ?? null) as
        | (typeof lastHealthCheckRows)[number]
        | null,
      recentIncidents,
      jobsQueue: Object.fromEntries(
        jobStats.map((r) => [r.status, r.count])
      ),
      activeAgents: agentCountResult[0]?.count ?? 0,
    });
  })

  // ---- GET /incidents — list with filters ----
  .get("/incidents", async (c) => {
    const service = c.req.query("service");
    const status = c.req.query("status");
    const severity = c.req.query("severity");
    const limit = Math.min(Number(c.req.query("limit") || 50), 200);

    const db = getDrizzleDb();
    const conditions = [];
    if (service) conditions.push(eq(serviceHealthIncidents.service, service));
    if (status) conditions.push(eq(serviceHealthIncidents.status, status));
    if (severity)
      conditions.push(eq(serviceHealthIncidents.severity, severity));

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalResult] = await Promise.all([
      db
        .select()
        .from(serviceHealthIncidents)
        .where(whereClause)
        .orderBy(desc(serviceHealthIncidents.detectedAt))
        .limit(limit),
      db
        .select({ count: count() })
        .from(serviceHealthIncidents)
        .where(whereClause),
    ]);

    return c.json({ incidents: rows, total: totalResult[0]?.count ?? 0 });
  })

  // ---- POST /incidents — record a new incident ----
  .post("/incidents", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = RecordIncidentSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const db = getDrizzleDb();

    // Check for existing open incident for same service+title (dedup)
    const existing = await db
      .select({ id: serviceHealthIncidents.id })
      .from(serviceHealthIncidents)
      .where(
        and(
          eq(serviceHealthIncidents.service, d.service),
          eq(serviceHealthIncidents.title, d.title),
          eq(serviceHealthIncidents.status, "open")
        )
      )
      .limit(1);

    if (existing.length > 0) {
      // Update existing instead of creating duplicate
      const updated = await db
        .update(serviceHealthIncidents)
        .set({
          detail: d.detail ?? undefined,
          metadata: d.metadata ?? undefined,
          updatedAt: new Date(),
        })
        .where(eq(serviceHealthIncidents.id, existing[0].id))
        .returning();
      return c.json(firstOrThrow(updated, "incident dedup update"), 200);
    }

    const inserted = await db
      .insert(serviceHealthIncidents)
      .values({
        service: d.service,
        severity: d.severity,
        title: d.title,
        detail: d.detail ?? null,
        checkSource: d.checkSource ?? null,
        metadata: d.metadata ?? null,
        githubIssueNumber: d.githubIssueNumber ?? null,
      })
      .returning();

    const incident = firstOrThrow(inserted, "incident insert");

    // For critical incidents, create a monitoring-alert job for agents to claim
    if (d.severity === "critical") {
      await db
        .insert(jobs)
        .values({
          type: "monitoring-alert",
          params: {
            incidentId: incident.id,
            service: d.service,
            title: d.title,
            severity: d.severity,
          },
          priority: 100,
          maxRetries: 1,
        })
        .catch((err: unknown) => {
          logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            "Failed to create monitoring-alert job",
          );
        });
    }

    return c.json(incident, 201);
  })

  // ---- PATCH /incidents/:id — update/resolve ----
  .patch("/incidents/:id", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (isNaN(id)) return validationError(c, "id must be a number");

    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = UpdateIncidentSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const d = parsed.data;
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (d.status !== undefined) {
      updates.status = d.status;
      if (d.status === "resolved") updates.resolvedAt = new Date();
    }
    if (d.resolvedBy !== undefined) updates.resolvedBy = d.resolvedBy;
    if (d.detail !== undefined) updates.detail = d.detail;
    if (d.metadata !== undefined) updates.metadata = d.metadata;
    if (d.githubIssueNumber !== undefined)
      updates.githubIssueNumber = d.githubIssueNumber;

    const db = getDrizzleDb();
    const result = await db
      .update(serviceHealthIncidents)
      .set(updates)
      .where(eq(serviceHealthIncidents.id, id))
      .returning();

    if (result.length === 0) return notFoundError(c, "Incident not found");
    return c.json(result[0]);
  });

export const monitoringRoute = monitoringApp;
export type MonitoringRoute = typeof monitoringApp;
