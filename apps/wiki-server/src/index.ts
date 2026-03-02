import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { initDb, closeDb } from "./db.js";
import { logger } from "./logger.js";

const PORT = parseInt(process.env.PORT || "3100", 10);

async function main() {
  if (process.env.SKIP_MIGRATIONS === "true") {
    logger.info("SKIP_MIGRATIONS=true — skipping database migrations");
  } else {
    logger.info("Initializing database...");
    await initDb();
  }

  const app = createApp();

  const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    logger.info({ port: info.port }, "Wiki server listening");
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
