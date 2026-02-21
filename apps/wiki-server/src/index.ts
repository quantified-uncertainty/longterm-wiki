import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { initDb, closeDb } from "./db.js";
import { initSearch } from "./search.js";

const PORT = parseInt(process.env.PORT || "3100", 10);

async function main() {
  console.log("Initializing database...");
  await initDb();
  await initSearch();

  const app = createApp();

  const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`Wiki server listening on port ${info.port}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down...");
    server.close();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
