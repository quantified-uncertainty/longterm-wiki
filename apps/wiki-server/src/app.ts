import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger.js";
import { validateApiKey } from "./auth.js";
import {
  rateLimitMiddleware,
  createDefaultRateLimiters,
} from "./rate-limit.js";
import { healthRoute } from "./routes/health.js";
import { idsRoute } from "./routes/ids.js";
import { citationsRoute } from "./routes/citations.js";
import { pagesRoute } from "./routes/pages.js";
import { editLogsRoute } from "./routes/edit-logs.js";
import { autoUpdateRunsRoute } from "./routes/auto-update-runs.js";
import { hallucinationRiskRoute } from "./routes/hallucination-risk.js";
import { sessionsRoute } from "./routes/sessions.js";
import { resourcesRoute } from "./routes/resources.js";
import { summariesRoute } from "./routes/summaries.js";
import { linksRoute } from "./routes/links.js";
import { autoUpdateNewsRoute } from "./routes/auto-update-news.js";
import { entitiesRoute } from "./routes/entities.js";
import { factsRoute } from "./routes/facts.js";
import { agentSessionsRoute } from "./routes/agent-sessions.js";
import { activeAgentsRoute } from "./routes/active-agents.js";
import { agentSessionEventsRoute } from "./routes/agent-session-events.js";
import { jobsRoute } from "./routes/jobs.js";
import { artifactsRoute } from "./routes/artifacts.js";
import { exploreRoute } from "./routes/explore.js";
import { integrityRoute } from "./routes/integrity.js";
import { referencesRoute } from "./routes/references.js";
import { githubIssuesRoute } from "./routes/github-issues.js";
import { groundskeeperRunsRoute } from "./routes/groundskeeper-runs.js";
import { monitoringRoute } from "./routes/monitoring.js";
import { githubPullsRoute } from "./routes/github-pulls.js";
import { factbaseVerificationsRoute } from "./routes/factbase-verifications.js";
import { personnelRoute } from "./routes/personnel.js";
import { peopleRoute } from "./routes/people.js";
import { grantsRoute } from "./routes/grants.js";
import { fundingRoundsRoute } from "./routes/funding-rounds.js";
import { investmentsRoute } from "./routes/investments.js";
import { equityPositionsRoute } from "./routes/equity-positions.js";
import { divisionsRoute } from "./routes/divisions.js";
import { divisionPersonnelRoute } from "./routes/division-personnel.js";
import { fundingProgramsRoute } from "./routes/funding-programs.js";
import { benchmarksRoute } from "./routes/benchmarks.js";
import { benchmarkResultsRoute } from "./routes/benchmark-results.js";
import { recordVerificationsRoute } from "./routes/record-verifications.js";
import { thingsRoute } from "./routes/things.js";
import { researchAreasRoute } from "./routes/research-areas.js";

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

  // Mount route handlers
  app.route("/api/ids", idsRoute);
  app.route("/api/citations", citationsRoute);
  app.route("/api/pages", pagesRoute);
  app.route("/api/edit-logs", editLogsRoute);
  app.route("/api/auto-update-runs", autoUpdateRunsRoute);
  app.route("/api/hallucination-risk", hallucinationRiskRoute);
  app.route("/api/sessions", sessionsRoute);
  app.route("/api/resources", resourcesRoute);
  app.route("/api/summaries", summariesRoute);
  app.route("/api/links", linksRoute);
  app.route("/api/auto-update-news", autoUpdateNewsRoute);
  app.route("/api/entities", entitiesRoute);
  app.route("/api/facts", factsRoute);
  app.route("/api/agent-sessions", agentSessionsRoute);
  app.route("/api/active-agents", activeAgentsRoute);
  app.route("/api/agent-session-events", agentSessionEventsRoute);
  app.route("/api/jobs", jobsRoute);
  app.route("/api/artifacts", artifactsRoute);
  app.route("/api/explore", exploreRoute);
  app.route("/api/integrity", integrityRoute);
  app.route("/api/references", referencesRoute);
  app.route("/api/github/issues", githubIssuesRoute);
  app.route("/api/github/pulls", githubPullsRoute);
  app.route("/api/groundskeeper-runs", groundskeeperRunsRoute);
  app.route("/api/monitoring", monitoringRoute);
  app.route("/api/kb-verifications", factbaseVerificationsRoute); // API path kept for backwards compat
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
  app.route("/api/things", thingsRoute);
  app.route("/api/research-areas", researchAreasRoute);

  return app;
}
