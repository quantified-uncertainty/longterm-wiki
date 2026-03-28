import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { initDb, closeDb } from "./db.js";
import { logger } from "./logger.js";
import { setMigrationError } from "./migration-state.js";

const PORT = parseInt(process.env.PORT || "3100", 10);

async function main() {
  let migrationFailed = false;

  if (process.env.SKIP_MIGRATIONS === "true") {
    logger.info("SKIP_MIGRATIONS=true — skipping database migrations");
  } else {
    logger.info("Initializing database...");
    try {
      await initDb();
    } catch (err) {
      // Start in degraded mode instead of crash-looping.
      // The health endpoint will report "degraded" with the error details,
      // giving operators visibility without requiring kubectl to diagnose.
      // Write endpoints will still work (the DB connection pool is separate
      // from the migration connection), but schema may be out of date.
      migrationFailed = true;
      const errorMessage = err instanceof Error ? err.message : String(err);
      setMigrationError(errorMessage);
      logger.error(
        { err },
        "Migration failed — starting in DEGRADED mode. " +
        "Health endpoint will report degraded status. " +
        "Fix the migration issue and restart the pod."
      );
    }
  }

  const app = createApp();

  const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    logger.info(
      { port: info.port, degraded: migrationFailed },
      migrationFailed
        ? "Wiki server listening in DEGRADED mode (migration failed)"
        : "Wiki server listening"
    );
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    server.close();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  process.exit(1);
});
