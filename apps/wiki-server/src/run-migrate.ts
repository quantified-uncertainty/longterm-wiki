import { initDb, closeDb } from "./db.js";
import { logger } from "./logger.js";

await initDb();
await closeDb();
logger.info("Migrations applied successfully.");
