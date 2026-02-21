import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bearerAuth } from "hono/bearer-auth";
import { healthRoute } from "./routes/health.js";
import { idsRoute } from "./routes/ids.js";
import { citationsRoute } from "./routes/citations.js";
import { pagesRoute } from "./routes/pages.js";
import { editLogsRoute } from "./routes/edit-logs.js";
import { hallucinationRiskRoute } from "./routes/hallucination-risk.js";
import { sessionsRoute } from "./routes/sessions.js";

export function createApp() {
  const app = new Hono();

  // Error handler — re-throw HTTPExceptions (auth failures etc.) so Hono
  // returns the proper status code; only catch unexpected errors as 500.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    console.error("Unhandled error:", err);
    return c.json(
      { error: "internal_error", message: "An unexpected error occurred" },
      500
    );
  });

  // Health endpoint — unauthenticated
  app.route("/health", healthRoute);

  // API routes — bearer auth required
  const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
  if (apiKey) {
    app.use("/api/*", bearerAuth({ token: apiKey }));
  } else {
    console.warn(
      "WARNING: LONGTERMWIKI_SERVER_API_KEY not set — API routes are unauthenticated"
    );
  }

  app.route("/api/ids", idsRoute);
  app.route("/api/citations", citationsRoute);
  app.route("/api/pages", pagesRoute);
  app.route("/api/edit-logs", editLogsRoute);
  app.route("/api/hallucination-risk", hallucinationRiskRoute);
  app.route("/api/sessions", sessionsRoute);

  return app;
}
