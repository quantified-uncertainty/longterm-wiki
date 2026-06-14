import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger.js";
import { validateApiKey } from "./auth.js";
import { getMigrationError } from "./migration-state.js";
import {
  rateLimitMiddleware,
  createDefaultRateLimiters,
} from "./rate-limit.js";
import { auditContextMiddleware } from "./middleware/audit-context.js";
// TableBase routes — typed relational entity records
// Most routes are mounted automatically via TABLEBASE_MOUNTS (QUA-454).
// The 5 imports below are the ones mounted manually in this file because
// they either have special semantics or serve as the cross-base index —
// see `mount-registry.ts` header for the full rationale.
import { entitiesRoute } from "./routes/tablebase/entities.js";
import { idsRoute } from "./routes/tablebase/ids.js";
import { thingsRoute } from "./routes/tablebase/things.js";
import { blueskyRoute } from "./routes/tablebase/bluesky.js";
import { dataSourcesRoute } from "./routes/tablebase/data-sources.js";
import { TABLEBASE_MOUNTS } from "./routes/tablebase/mount-registry.js";

// Unified sourcing system (replaces legacy factbase + record sourcing)
import { sourcingRoute } from "./routes/sourcing/sourcing.js";
import { urlSuggestionsRoute } from "./routes/sourcing/url-suggestions.js";
import { missingSourcesRoute } from "./routes/sourcing/missing-sources/route.js";

// Claims-first sourcing system (#3253)
import { claimsRoute } from "./routes/claims/claims.js";

// Defensive enrichment gate (QUA-632 Phase 1)
import { enrichmentRoute } from "./routes/enrichment/enrichment.js";

// FactBase routes — structured triples with temporal data
import { factsRoute } from "./routes/factbase/facts.js";

// WikiBase routes — long-form prose, citations, references
import { pagesRoute } from "./routes/wikibase/pages.js";
import { linksRoute } from "./routes/wikibase/links.js";
import { citationsRoute } from "./routes/wikibase/citations.js";
import { resourcesRoute } from "./routes/wikibase/resources.js";
import { hallucinationRiskRoute } from "./routes/wikibase/hallucination-risk.js";
import { assessmentsRoute } from "./routes/wikibase/assessments.js";
import { exploreRoute } from "./routes/wikibase/explore.js";
import { editLogsRoute } from "./routes/wikibase/edit-logs.js";
import { summariesRoute } from "./routes/wikibase/summaries.js";
import { referencesRoute } from "./routes/wikibase/references.js";

// Operational routes — sessions, agents, jobs, monitoring, infra
import { healthRoute } from "./routes/operational/health.js";
import { sessionsRoute } from "./routes/operational/sessions.js";
import { agentSessionsRoute } from "./routes/operational/agent-sessions.js";
import { activeAgentsRoute } from "./routes/operational/active-agents.js";
import { agentSessionEventsRoute } from "./routes/operational/agent-session-events.js";
import { jobsRoute } from "./routes/operational/jobs.js";
import { artifactsRoute } from "./routes/operational/artifacts.js";
import { integrityRoute } from "./routes/operational/integrity.js";
import { autoUpdateRunsRoute } from "./routes/operational/auto-update-runs.js";
import { autoUpdateNewsRoute } from "./routes/operational/auto-update-news.js";
import { groundskeeperRunsRoute } from "./routes/operational/groundskeeper-runs.js";
import { pipelineRunsRoute } from "./routes/operational/pipeline-runs.js";
import { llmPayloadsRoute } from "./routes/operational/llm-payloads.js";
import { githubIssuesRoute } from "./routes/operational/github-issues.js";
import { githubPullsRoute } from "./routes/operational/github-pulls.js";
import { monitoringRoute } from "./routes/operational/monitoring.js";
import { buildMetricsRoute } from "./routes/operational/build-metrics.js";
import { qaChecksRoute } from "./routes/operational/qa-checks.js";
import { dataQualityRoute } from "./routes/operational/data-quality.js";
import { thingsSearchRefreshRoute } from "./routes/operational/things-search-refresh.js";
import { operationsLogRoute } from "./routes/operational/operations-log.js";
import { auditLogRoute } from "./routes/operational/audit-log.js";
import { frameworkReviewRoute } from "./routes/operational/framework-review.js";

let requestCounter = 0;

export function createApp() {
  const app = new Hono();

  // Request logging middleware
  app.use("*", async (c, next) => {
    const requestId = `req-${++requestCounter}`;
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;

    await next();

    const durationMs = Date.now() - start;
    const status = c.res.status;

    const logData = { requestId, method, path, status, durationMs };
    if (status >= 500) {
      logger.error(logData, "request error");
    } else if (status >= 400) {
      logger.warn(logData, "request warning");
    } else {
      logger.info(logData, "request");
    }
  });

  // Rate limiting middleware — applied before auth so that abusive traffic
  // is rejected early without touching the database or auth layer.
  // Health and healthz endpoints are exempt so monitoring probes are never throttled.
  //
  // Authenticated requests (valid Bearer token) skip rate limiting entirely —
  // the auth middleware already prevents abuse, and rate limiting internal
  // traffic (Vercel ISR, CI sync, crux CLI) caused self-inflicted 429s during
  // builds when 50+ pages revalidated concurrently from the same IP (#3720).
  //
  // Unauthenticated traffic gets stricter limits (100 read / 20 write per min).
  const { readLimiter, writeLimiter } = createDefaultRateLimiters();
  readLimiter.startCleanup();
  writeLimiter.startCleanup();

  app.use(
    "*",
    rateLimitMiddleware({
      readLimiter,
      writeLimiter,
      skipPaths: ["/health", "/healthz"],
    })
  );

  // Error handler — re-throw HTTPExceptions (auth failures etc.) so Hono
  // returns the proper status code; only catch unexpected errors as 500.
  // For /api/* routes (already behind bearer auth), include the real error
  // message so authenticated callers get actionable diagnostics.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      // Hono's built-in JSON validator throws HTTPException(400) with a
      // plain-text body when the request body is malformed JSON.  Convert
      // it to a structured JSON response so clients always get JSON back.
      if (err.status === 400 && err.message.includes("Malformed JSON")) {
        return c.json({ error: "invalid_json", message: err.message }, 400);
      }
      return err.getResponse();
    }
    logger.error({ err, path: c.req.path }, "Unhandled error");
    const message =
      c.req.path.startsWith("/api/") && err instanceof Error
        ? err.message
        : "An unexpected error occurred";
    return c.json({ error: "internal_error", message }, 500);
  });

  // Lightweight liveness probe — no DB queries, no auth, no rate limiting.
  // Use this for K8s liveness probes and groundskeeper health checks.
  app.get("/healthz", (c) => {
    return c.json({ status: "ok" });
  });

  // Readiness probe — returns 503 if migrations failed (degraded mode).
  // K8s readiness probes should use this endpoint to prevent routing traffic
  // to pods that started with a schema mismatch. During rolling deploys,
  // traffic stays on old (working) pods until the new pod is fully ready.
  app.get("/readyz", (c) => {
    const migrationError = getMigrationError();
    if (migrationError) {
      // Don't expose raw error — it may contain SQL/table names.
      // Full details are in server logs.
      return c.json(
        { status: "not-ready", reason: "migration_failed" },
        503
      );
    }
    return c.json({ status: "ready" });
  });

  // Detailed health endpoint — unauthenticated, includes DB stats
  app.route("/health", healthRoute);

  // API routes — all require a valid API key
  app.use("/api/*", validateApiKey());

  // Audit-context middleware (QUA-442). Reads X-Agent-Session-Id and
  // X-Agent-Tool from authenticated API requests and stashes them on the
  // Hono context for `applyAuditContext(tx, c)` to pick up. No DB
  // interaction here — all SET LOCAL happens inside the route's
  // transaction.
  app.use("/api/*", auditContextMiddleware());

  // ── Route mounting ───────────────────────────────────────────────────
  // Routes are grouped by which data layer ("Base") they primarily serve.
  // See content/docs/internal/data-architecture.mdx for the Three Bases guide.

  // TableBase routes — excluded from the auto-mount registry because each
  // has bespoke concerns (see mount-registry.ts header). Everything else
  // in tablebase/ is mounted via TABLEBASE_MOUNTS below.
  app.route("/api/ids", idsRoute);
  app.route("/api/entities", entitiesRoute);
  app.route("/api/things", thingsRoute);
  app.route("/api/bluesky", blueskyRoute);
  app.route("/api/data-sources", dataSourcesRoute);

  // TableBase routes — auto-mounted from the registry (QUA-454).
  // Adding a new tablebase route? Append to `mount-registry.ts` — this
  // loop picks it up on next restart. The registry test enforces that
  // the set matches the filesystem.
  for (const { path, route } of TABLEBASE_MOUNTS) {
    app.route(path, route);
  }

  // WikiBase & shared routes that happen to live next to TableBase
  app.route("/api/resources", resourcesRoute);
  app.route("/api/summaries", summariesRoute);
  app.route("/api/links", linksRoute);
  app.route("/api/explore", exploreRoute);

  // FactBase routes — structured facts
  app.route("/api/facts", factsRoute);
  // Unified sourcing system — mount sub-routes before the catch-all parent.
  app.route("/api/sourcing/url-suggestions", urlSuggestionsRoute);
  app.route("/api/sourcing/missing-sources", missingSourcesRoute);
  app.route("/api/sourcing", sourcingRoute);

  // WikiBase routes — prose content and page metadata
  app.route("/api/pages", pagesRoute);
  app.route("/api/edit-logs", editLogsRoute);
  app.route("/api/references", referencesRoute);

  // Citation & sourcing system (operational, not part of a Base)
  app.route("/api/citations", citationsRoute);
  app.route("/api/hallucination-risk", hallucinationRiskRoute);
  app.route("/api/integrity", integrityRoute);

  // Claims-first sourcing (#3253)
  app.route("/api/claims", claimsRoute);

  // Defensive enrichment gate (QUA-632 Phase 1)
  app.route("/api/enrichment", enrichmentRoute);

  // WikiBase assessments (not in the TableBase registry — separate concern)
  app.route("/api/assessments", assessmentsRoute);


  // Agent & session tracking (operational)
  app.route("/api/sessions", sessionsRoute);
  app.route("/api/agent-sessions", agentSessionsRoute);
  app.route("/api/active-agents", activeAgentsRoute);
  app.route("/api/agent-session-events", agentSessionEventsRoute);

  // Auto-update system (operational)
  app.route("/api/auto-update-runs", autoUpdateRunsRoute);
  app.route("/api/auto-update-news", autoUpdateNewsRoute);

  // Infrastructure & monitoring (operational)
  app.route("/api/jobs", jobsRoute);
  app.route("/api/artifacts", artifactsRoute);
  app.route("/api/github/issues", githubIssuesRoute);
  app.route("/api/github/pulls", githubPullsRoute);
  app.route("/api/groundskeeper-runs", groundskeeperRunsRoute);
  app.route("/api/pipeline-runs", pipelineRunsRoute);
  app.route("/api/llm-payloads", llmPayloadsRoute);
  app.route("/api/monitoring", monitoringRoute);
  app.route("/api/build-metrics", buildMetricsRoute);
  app.route("/api/qa-checks", qaChecksRoute);
  app.route("/api/data-quality", dataQualityRoute);
  app.route("/api/things-search", thingsSearchRefreshRoute);
  app.route("/api/operations-log", operationsLogRoute);
  app.route("/api/audit-log", auditLogRoute);
  app.route("/api/framework-review", frameworkReviewRoute);

  return app;
}
