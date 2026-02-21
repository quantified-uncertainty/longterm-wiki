import { initDb, closeDb } from "./db.js";

await initDb();
await closeDb();
console.log("Migrations applied successfully.");
