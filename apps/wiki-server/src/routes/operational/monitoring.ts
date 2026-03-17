import { Hono } from "hono";
import { eq, desc, and, count, gte, sql } from "drizzle-orm";
import { getDrizzleDb, getDb } from "../../db.js";
import {
  serviceHealthIncidents,
  activeAgents,
  groundskeeperRuns,
  jobs,
  autoUpdateRuns,
} from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  firstOrThrow,
} from "../shared/utils.js";
import {
  RecordIncidentSchema,
  UpdateIncidentSchema,
} from "../../api-types.js";
import { logger } from "../../logger.js";

// Static service registry — no DB table needed.
// Only includes services with actual health check wiring.
// discord-bot and vercel-frontend were removed because they permanently
// showed "unknown" / "Not monitored" with no health check logic.
const SERVICES = [
  "wiki-server",
  "groundskeeper",
  "github-actions",
] as const;

// Expected migration count — update this when adding new drizzle migrations.
// Read from apps/wiki-server/drizzle/meta/_journal.json entries length.
const EXPECTED_MIGRATION_COUNT = 98;

// ── Typed row interfaces for raw SQL results ────────────────────────────
interface DbCountsRow {
  pages: number;
  entities: number;
  facts: number;
}

interface IntegritySummaryRow {
  dangling_facts: number;
  dangling_summaries: number;
  dangling_citations: number;
  dangling_edit_logs: number;
}

interface ActiveAgentRow {
  id: number;
  session_id: string;
  branch: string | null;
  task: string | null;
  status: string;
  issue_number: number | null;
  pr_number: number | null;
  started_at: string | null;
  completed_at: string | null;
  model: string | null;
}

interface MigrationRow {
  id: number;
  hash: string;
  created_at: number;
}

interface AgentActivityRow {
  active_now: number;
  sessions_this_week: number;
  prs_this_week: number;
  completed_this_week: number;
}

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
      const row = countsResult[0] as DbCountsRow;
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

    // 3. Open incidents per service
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

    // 7. Active agents count (exclude stale — no heartbeat in 15 min)
    const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);
    const agentCountResult = await db
      .select({ count: count() })
      .from(activeAgents)
      .where(
        and(
          eq(activeAgents.status, "active"),
          gte(activeAgents.heartbeatAt, staleThreshold)
        )
      );

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

    const knownServices = services.filter(
      (s) => s.status === "healthy" || s.status === "degraded" || s.status === "down"
    );
    const overallStatus = services.some((s) => s.status === "down")
      ? "down"
      : services.some((s) => s.status === "degraded")
        ? "degraded"
        : knownServices.length === 0
          ? "unknown"
          : knownServices.every((s) => s.status === "healthy")
            ? "healthy"
            : "unknown";

    return c.json({
      overall: overallStatus as string,
      checkedAt: new Date().toISOString(),
      services,
      dbCounts,
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

    // Note: Previously created a "monitoring-alert" job for critical incidents,
    // but no job handler exists for this type — every such job permanently failed
    // with "Unknown job type: monitoring-alert". Removed in #2193.
    // The incident is already recorded in service_health_incidents and the
    // groundskeeper handles alerting via GitHub issues and Discord.

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
  })

  // ---- GET /extended — additional health data for the dashboard ----
  .get("/extended", async (c) => {
    const db = getDrizzleDb();
    const rawDb = getDb();

    // Run all queries in parallel — each with .catch() so a single failure
    // doesn't take down the entire /extended endpoint (see #1909).
    const [
      ciResult,
      gkStatsResult,
      integrityResult,
      autoUpdateResult,
      recentSessionsResult,
      migrationsResult,
      deploysResult,
      agentActivityResult,
      apiKeysResult,
    ] = await Promise.all([
      fetchCiStatus().catch(catchWith("CI status", null)),
      fetchGroundskeeperStats(db).catch(catchWith("groundskeeper stats", [] as Awaited<ReturnType<typeof fetchGroundskeeperStats>>)),
      fetchIntegritySummary(rawDb).catch(catchWith("integrity summary",
        { totalDanglingRefs: 0, status: "error" as const, breakdown: { facts: 0, summaries: 0, citations: 0, editLogs: 0 } })),
      fetchAutoUpdateStats(db).catch(catchWith("auto-update stats", { totalRuns: 0, recentRuns: [] as { id: number; date: string; trigger: string; pagesUpdated: number; pagesFailed: number; budgetSpent: number; completed: boolean }[] })),
      fetchRecentSessions(rawDb).catch(catchWith("recent sessions", [])),
      fetchMigrationStatus(rawDb).catch(catchWith("migration status", null)),
      fetchDeployHistory().catch(catchWith("deploy history", null)),
      fetchAgentActivity(rawDb).catch(catchWith("agent activity", { activeNow: 0, sessionsThisWeek: 0, prsThisWeek: 0, completedThisWeek: 0, completionRate: null as number | null })),
      fetchApiKeyHealth().catch(catchWith("API key health", null)),
    ]);

    // Derive GitHub API key health from CI result to avoid a redundant API call
    const apiKeysWithGithub = apiKeysResult
      ? apiKeysResult
      : null;
    if (apiKeysWithGithub) {
      apiKeysWithGithub.github = {
        configured: !!process.env.GITHUB_TOKEN,
        healthy: ciResult !== null,
      };
    }

    return c.json({
      ci: ciResult,
      groundskeeperTasks: gkStatsResult,
      integrity: integrityResult,
      autoUpdate: autoUpdateResult,
      recentSessions: recentSessionsResult,
      migrations: migrationsResult,
      deploys: deploysResult,
      agentActivity: agentActivityResult,
      apiKeys: apiKeysResult,
    });
  });

/** Log a warning and return a fallback value — DRY wrapper for Promise.all .catch() handlers. */
function catchWith<T>(label: string, fallback: T) {
  return (err: unknown) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, `Failed to fetch ${label}`);
    return fallback;
  };
}

// ---- Helper functions for /extended endpoint ----

const GITHUB_REPO = "quantified-uncertainty/longterm-wiki";

interface CiCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

async function fetchCiStatus() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;

  // Get the latest commit on main
  const branchResp = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/branches/main`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!branchResp.ok) return null;

  const branch = (await branchResp.json()) as {
    commit: { sha: string };
  };
  const sha = branch.commit.sha;

  // Get check runs for that commit
  const checksResp = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/commits/${sha}/check-runs`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!checksResp.ok) return null;

  const checksData = (await checksResp.json()) as {
    total_count: number;
    check_runs: Array<{
      name: string;
      status: string;
      conclusion: string | null;
      completed_at: string | null;
    }>;
  };

  const checks: CiCheckRun[] = checksData.check_runs.map((r) => ({
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
  }));

  const allCompleted = checks.every((ch) => ch.status === "completed");
  const anyFailed = checks.some((ch) => ch.conclusion === "failure");
  // Only count as "all passed" if every non-skipped check succeeded
  const nonSkipped = checks.filter((ch) => ch.conclusion !== "skipped");
  const allPassed =
    allCompleted && nonSkipped.length > 0 && nonSkipped.every((ch) => ch.conclusion === "success");

  return {
    sha: sha.slice(0, 8),
    totalChecks: checksData.total_count,
    allCompleted,
    allPassed,
    anyFailed,
    checks,
  };
}

async function fetchGroundskeeperStats(db: ReturnType<typeof getDrizzleDb>) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      taskName: groundskeeperRuns.taskName,
      totalRuns: sql<number>`count(*)::int`,
      successCount: sql<number>`count(*) filter (where ${groundskeeperRuns.success} = true)::int`,
      failureCount: sql<number>`count(*) filter (where ${groundskeeperRuns.success} = false)::int`,
      avgDurationMs: sql<number>`avg(${groundskeeperRuns.durationMs})::int`,
      lastRun: sql<string>`max(${groundskeeperRuns.timestamp})`,
    })
    .from(groundskeeperRuns)
    .where(gte(groundskeeperRuns.timestamp, since))
    .groupBy(groundskeeperRuns.taskName);

  return rows.map((r) => ({
    taskName: r.taskName,
    totalRuns: r.totalRuns,
    successCount: r.successCount,
    failureCount: r.failureCount,
    successRate: r.totalRuns > 0 ? Math.round((r.successCount / r.totalRuns) * 100) : null,
    avgDurationMs: r.avgDurationMs,
    lastRun: r.lastRun,
  }));
}

async function fetchIntegritySummary(rawDb: ReturnType<typeof getDb>) {
  // Quick count of dangling refs across key tables
  const result = await rawDb`
    SELECT
      (SELECT count(*) FROM facts WHERE entity_id NOT IN (SELECT stable_id FROM entities WHERE stable_id IS NOT NULL))::int AS dangling_facts,
      (SELECT count(*) FROM summaries WHERE entity_id NOT IN (SELECT stable_id FROM entities WHERE stable_id IS NOT NULL))::int AS dangling_summaries,
      -- Only flag truly orphaned records where BOTH the legacy text page_id and the new integer
      -- page_id_int are NULL. Records with page_id_old populated but page_id_int NULL are
      -- pre-migration artifacts (Phase D / Phase 4a), not data corruption.
      (SELECT count(*) FROM citation_quotes WHERE page_id_old IS NULL AND (page_id_int IS NULL OR page_id_int NOT IN (SELECT integer_id FROM wiki_pages)))::int AS dangling_citations,
      (SELECT count(*) FROM edit_logs WHERE page_id_old IS NULL AND (page_id_int IS NULL OR page_id_int NOT IN (SELECT integer_id FROM wiki_pages)))::int AS dangling_edit_logs
  `;

  const row = result[0] as IntegritySummaryRow;

  const totalDangling =
    row.dangling_facts +
    row.dangling_summaries +
    row.dangling_citations +
    row.dangling_edit_logs;

  return {
    totalDanglingRefs: totalDangling,
    status: totalDangling === 0 ? "clean" : "issues_found",
    breakdown: {
      facts: row.dangling_facts,
      summaries: row.dangling_summaries,
      citations: row.dangling_citations,
      editLogs: row.dangling_edit_logs,
    },
  };
}

async function fetchAutoUpdateStats(db: ReturnType<typeof getDrizzleDb>) {
  const [totalResult, recentRuns] = await Promise.all([
    db.select({ count: count() }).from(autoUpdateRuns),
    db
      .select({
        id: autoUpdateRuns.id,
        date: autoUpdateRuns.date,
        trigger: autoUpdateRuns.trigger,
        pagesUpdated: autoUpdateRuns.pagesUpdated,
        pagesFailed: autoUpdateRuns.pagesFailed,
        budgetSpent: autoUpdateRuns.budgetSpent,
        completedAt: autoUpdateRuns.completedAt,
      })
      .from(autoUpdateRuns)
      .orderBy(desc(autoUpdateRuns.startedAt))
      .limit(5),
  ]);

  return {
    totalRuns: totalResult[0]?.count ?? 0,
    recentRuns: recentRuns.map((r) => ({
      id: r.id,
      date: r.date,
      trigger: r.trigger,
      pagesUpdated: r.pagesUpdated ?? 0,
      pagesFailed: r.pagesFailed ?? 0,
      budgetSpent: r.budgetSpent ?? 0,
      completed: r.completedAt !== null,
    })),
  };
}

async function fetchRecentSessions(rawDb: ReturnType<typeof getDb>) {
  const rows = await rawDb`
    SELECT
      id, session_id, branch, task, status, issue_number, pr_number,
      started_at, completed_at, model
    FROM active_agents
    WHERE status != 'stale'
    ORDER BY started_at DESC NULLS LAST
    LIMIT 10
  `;

  return rows.map((r) => ({
    id: r.id as ActiveAgentRow["id"],
    sessionId: r.session_id as ActiveAgentRow["session_id"],
    branch: (r.branch as ActiveAgentRow["branch"]) ?? null,
    task: (r.task as ActiveAgentRow["task"]) ?? null,
    status: r.status as ActiveAgentRow["status"],
    issueNumber: (r.issue_number as ActiveAgentRow["issue_number"]) ?? null,
    prNumber: (r.pr_number as ActiveAgentRow["pr_number"]) ?? null,
    startedAt: r.started_at ? String(r.started_at) : null,
    completedAt: r.completed_at ? String(r.completed_at) : null,
    model: (r.model as ActiveAgentRow["model"]) ?? null,
  }));
}

// ---- Migration status ----

async function fetchMigrationStatus(rawDb: ReturnType<typeof getDb>) {
  const [countResult, recentResult] = await Promise.all([
    rawDb`SELECT count(*)::int AS total FROM drizzle.__drizzle_migrations`,
    rawDb`
      SELECT id, hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY id DESC
      LIMIT 10
    `,
  ]);

  const appliedCount = (countResult[0] as { total: number }).total;
  const recent = recentResult.map((r) => ({
    id: r.id as MigrationRow["id"],
    hash: r.hash as MigrationRow["hash"],
    createdAt: new Date(Number(r.created_at)).toISOString(),
  }));

  return {
    appliedCount,
    expectedCount: EXPECTED_MIGRATION_COUNT,
    inSync: appliedCount >= EXPECTED_MIGRATION_COUNT,
    recent,
  };
}

// ---- Deploy history ----

async function fetchDeployHistory() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;

  const resp = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/wiki-server-docker.yml/runs?per_page=10&status=completed`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(8000),
    }
  );
  if (!resp.ok) return null;

  const data = (await resp.json()) as {
    workflow_runs: Array<{
      id: number;
      status: string;
      conclusion: string | null;
      created_at: string;
      updated_at: string;
      head_sha: string;
      run_number: number;
    }>;
  };

  return {
    recent: data.workflow_runs.map((run) => {
      const createdMs = new Date(run.created_at).getTime();
      const updatedMs = new Date(run.updated_at).getTime();
      const durationSeconds =
        !isNaN(createdMs) && !isNaN(updatedMs)
          ? Math.round((updatedMs - createdMs) / 1000)
          : null;

      return {
        id: run.id,
        status: run.status,
        conclusion: run.conclusion ?? "unknown",
        createdAt: run.created_at,
        headSha: run.head_sha,
        runNumber: run.run_number,
        durationSeconds,
      };
    }),
  };
}

// ---- Agent activity summary ----

async function fetchAgentActivity(rawDb: ReturnType<typeof getDb>) {
  const result = await rawDb`
    SELECT
      count(*) FILTER (WHERE status = 'active' AND heartbeat_at >= now() - interval '15 minutes')::int AS active_now,
      count(*) FILTER (WHERE started_at >= now() - interval '7 days')::int AS sessions_this_week,
      count(*) FILTER (WHERE started_at >= now() - interval '7 days' AND pr_number IS NOT NULL)::int AS prs_this_week,
      count(*) FILTER (WHERE started_at >= now() - interval '7 days' AND status = 'completed')::int AS completed_this_week
    FROM active_agents
  `;

  const row = result[0] as AgentActivityRow;
  const completionRate =
    row.sessions_this_week > 0
      ? Math.round((row.completed_this_week / row.sessions_this_week) * 100)
      : null;

  return {
    activeNow: row.active_now,
    sessionsThisWeek: row.sessions_this_week,
    prsThisWeek: row.prs_this_week,
    completedThisWeek: row.completed_this_week,
    completionRate,
  };
}

// ---- API key health ----

async function fetchApiKeyHealth() {
  const checkKey = async (
    envVar: string,
    testFn: (key: string) => Promise<boolean>
  ): Promise<{ configured: boolean; healthy: boolean }> => {
    const key = process.env[envVar];
    if (!key) return { configured: false, healthy: false };
    try {
      const healthy = await testFn(key);
      return { configured: true, healthy };
    } catch {
      return { configured: true, healthy: false };
    }
  };

  // GitHub key health is derived from fetchCiStatus() result after Promise.all
  // to avoid a redundant API call — see the /extended handler.
  const github = { configured: !!process.env.GITHUB_TOKEN, healthy: false };

  const [anthropic, openrouter] = await Promise.all([
    checkKey("ANTHROPIC_API_KEY", async (key) => {
      const resp = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    }),

    // OpenRouter
    checkKey("OPENROUTER_API_KEY", async (key) => {
      const resp = await fetch("https://openrouter.ai/api/v1/models", {
        headers: {
          Authorization: `Bearer ${key}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    }),
  ]);

  return { github, anthropic, openrouter };
}

export const monitoringRoute = monitoringApp;
export type MonitoringRoute = typeof monitoringApp;
