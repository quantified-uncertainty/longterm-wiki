import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validateApiKey, requireWriteScope } from "./auth.js";
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
import { claimsRoute } from "./routes/claims.js";
import { linksRoute } from "./routes/links.js";
import { autoUpdateNewsRoute } from "./routes/auto-update-news.js";
import { entitiesRoute } from "./routes/entities.js";
import { factsRoute } from "./routes/facts.js";
import { agentSessionsRoute } from "./routes/agent-sessions.js";
import { activeAgentsRoute } from "./routes/active-agents.js";
import { jobsRoute } from "./routes/jobs.js";
import { artifactsRoute } from "./routes/artifacts.js";
import { exploreRoute } from "./routes/explore.js";
import { integrityRoute } from "./routes/integrity.js";
import { referencesRoute } from "./routes/references.js";
import { githubIssuesRoute } from "./routes/github-issues.js";
import { groundskeeperRunsRoute } from "./routes/groundskeeper-runs.js";

export function createApp() {
  const app = new Hono();

  // Error handler — re-throw HTTPExceptions (auth failures etc.) so Hono
  // returns the proper status code; only catch unexpected errors as 500.
  // For /api/* routes (already behind bearer auth), include the real error
  // message so authenticated callers get actionable diagnostics.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    console.error("Unhandled error:", err);
    const message =
      c.req.path.startsWith("/api/") && err instanceof Error
        ? err.message
        : "An unexpected error occurred";
    return c.json({ error: "internal_error", message }, 500);
  });

  // Health endpoint — unauthenticated
  app.route("/health", healthRoute);

  // API routes — all require a valid API key (any scope)
  app.use("/api/*", validateApiKey());

  // Content-scope routes: writes require the content key
  // (reads/GETs work with any valid key)
  app.use("/api/pages/*", requireWriteScope("content"));
  app.use("/api/entities/*", requireWriteScope("content"));
  app.use("/api/facts/*", requireWriteScope("content"));
  app.use("/api/claims/*", requireWriteScope("content"));
  app.use("/api/citations/*", requireWriteScope("content"));
  app.use("/api/resources/*", requireWriteScope("content"));
  app.use("/api/links/*", requireWriteScope("content"));
  app.use("/api/summaries/*", requireWriteScope("content"));
  app.use("/api/hallucination-risk/*", requireWriteScope("content"));
  app.use("/api/artifacts/*", requireWriteScope("content"));
  app.use("/api/references/*", requireWriteScope("content"));

  // Project-scope routes: writes require the project key
  // (IDs, sessions, edit logs, jobs, agent sessions, auto-update tracking)
  app.use("/api/ids/*", requireWriteScope("project"));
  app.use("/api/sessions/*", requireWriteScope("project"));
  app.use("/api/edit-logs/*", requireWriteScope("project"));
  app.use("/api/jobs/*", requireWriteScope("project"));
  app.use("/api/agent-sessions/*", requireWriteScope("project"));
  app.use("/api/active-agents/*", requireWriteScope("project"));
  app.use("/api/auto-update-runs/*", requireWriteScope("project"));
  app.use("/api/auto-update-news/*", requireWriteScope("project"));
  app.use("/api/github/*", requireWriteScope("project"));
  app.use("/api/groundskeeper-runs/*", requireWriteScope("project"));

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
  app.route("/api/claims", claimsRoute);
  app.route("/api/links", linksRoute);
  app.route("/api/auto-update-news", autoUpdateNewsRoute);
  app.route("/api/entities", entitiesRoute);
  app.route("/api/facts", factsRoute);
  app.route("/api/agent-sessions", agentSessionsRoute);
  app.route("/api/active-agents", activeAgentsRoute);
  app.route("/api/jobs", jobsRoute);
  app.route("/api/artifacts", artifactsRoute);
  app.route("/api/explore", exploreRoute);
  app.route("/api/integrity", integrityRoute);
  app.route("/api/references", referencesRoute);
  app.route("/api/github/issues", githubIssuesRoute);
  app.route("/api/groundskeeper-runs", groundskeeperRunsRoute);

  return app;
}
