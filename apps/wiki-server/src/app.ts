import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger.js";
import { validateApiKey } from "./auth.js";
import {
  rateLimitMiddleware,
  createDefaultRateLimiters,
} from "./rate-limit.js";
// TableBase routes — typed relational entity records
import { entitiesRoute } from "./routes/tablebase/entities.js";
import { idsRoute } from "./routes/tablebase/ids.js";
import { personnelRoute } from "./routes/tablebase/personnel.js";
import { peopleRoute } from "./routes/tablebase/people.js";
import { grantsRoute } from "./routes/tablebase/grants.js";
import { divisionsRoute } from "./routes/tablebase/divisions.js";
import { divisionPersonnelRoute } from "./routes/tablebase/division-personnel.js";
import { investmentsRoute } from "./routes/tablebase/investments.js";
import { fundingRoundsRoute } from "./routes/tablebase/funding-rounds.js";
import { equityPositionsRoute } from "./routes/tablebase/equity-positions.js";
import { fundingProgramsRoute } from "./routes/tablebase/funding-programs.js";
import { benchmarksRoute } from "./routes/tablebase/benchmarks.js";
import { benchmarkResultsRoute } from "./routes/tablebase/benchmark-results.js";
import { recordVerificationsRoute } from "./routes/tablebase/record-verifications.js";
import { thingsRoute } from "./routes/tablebase/things.js";
import { researchAreasRoute } from "./routes/tablebase/research-areas.js";

// FactBase routes — structured triples with temporal data
import { factsRoute } from "./routes/factbase/facts.js";
import { factbaseVerificationsRoute } from "./routes/factbase/factbase-verifications.js";

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
import { githubIssuesRoute } from "./routes/operational/github-issues.js";
import { githubPullsRoute } from "./routes/operational/github-pulls.js";
import { monitoringRoute } from "./routes/operational/monitoring.js";

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
  // Health endpoint is exempt so monitoring probes are never throttled.
  // Authenticated traffic gets higher limits (1000 read/200 write per min)
  // vs unauthenticated (100 read/20 write) to avoid blocking internal
  // infrastructure (CI sync, Next.js ISR, crux CLI) while still providing
  // a circuit breaker against runaway scripts.
  const { readLimiter, writeLimiter, authReadLimiter, authWriteLimiter } =
    createDefaultRateLimiters();
  readLimiter.startCleanup();
  writeLimiter.startCleanup();
  authReadLimiter.startCleanup();
  authWriteLimiter.startCleanup();

  app.use(
    "*",
    rateLimitMiddleware({
      readLimiter,
      writeLimiter,
      authReadLimiter,
      authWriteLimiter,
      skipPaths: ["/health", "/healthz"],
    })
  );

  // Error handler — re-throw HTTPExceptions (auth failures etc.) so Hono
  // returns the proper status code; only catch unexpected errors as 500.
  // For /api/* routes (already behind bearer auth), include the real error
  // message so authenticated callers get actionable diagnostics.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
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
  // Use this for K8s probes and groundskeeper health checks.
  app.get("/healthz", (c) => {
    return c.json({ status: "ok" });
  });

  // Detailed health endpoint — unauthenticated, includes DB stats
  app.route("/health", healthRoute);

  // API routes — all require a valid API key
  app.use("/api/*", validateApiKey());

  // ── Route mounting ───────────────────────────────────────────────────
  // Routes are grouped by which data layer ("Base") they primarily serve.
  // See content/docs/internal/data-architecture.mdx for the Three Bases guide.

  // TableBase routes — YAML entity/resource catalog
  app.route("/api/ids", idsRoute);
  app.route("/api/entities", entitiesRoute);
  app.route("/api/resources", resourcesRoute);
  app.route("/api/summaries", summariesRoute);
  app.route("/api/links", linksRoute);
  app.route("/api/explore", exploreRoute);

  // FactBase routes — structured facts and verification
  app.route("/api/facts", factsRoute);
  app.route("/api/kb-verifications", factbaseVerificationsRoute); // API path kept for backwards compat

  // WikiBase routes — prose content and page metadata
  app.route("/api/pages", pagesRoute);
  app.route("/api/edit-logs", editLogsRoute);
  app.route("/api/references", referencesRoute);

  // Citation & verification system (operational, not part of a Base)
  app.route("/api/citations", citationsRoute);
  app.route("/api/hallucination-risk", hallucinationRiskRoute);
  app.route("/api/integrity", integrityRoute);

  // Financial data routes (operational — personnel, grants, funding)
  app.route("/api/personnel", personnelRoute);
  app.route("/api/people", peopleRoute);
  app.route("/api/grants", grantsRoute);
  app.route("/api/funding-rounds", fundingRoundsRoute);
  app.route("/api/investments", investmentsRoute);
  app.route("/api/equity-positions", equityPositionsRoute);
  app.route("/api/divisions", divisionsRoute);
  app.route("/api/division-personnel", divisionPersonnelRoute);
  app.route("/api/funding-programs", fundingProgramsRoute);
  app.route("/api/benchmarks", benchmarksRoute);
  app.route("/api/benchmark-results", benchmarkResultsRoute);
  app.route("/api/record-verifications", recordVerificationsRoute);
  app.route("/api/assessments", assessmentsRoute);

  // Cross-Base: unified things index
  app.route("/api/things", thingsRoute);
  app.route("/api/research-areas", researchAreasRoute);

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
  app.route("/api/monitoring", monitoringRoute);

  return app;
}
