/**
 * seed.ts — Populate the entity_ids table from an existing id-registry.json
 *
 * Reads the registry file, inserts all entries, and advances the sequence
 * so nextval() returns maxId + 1.
 *
 * Usage:
 *   DATABASE_URL=... tsx src/seed.ts
 *   DATABASE_URL=... ID_REGISTRY_PATH=/path/to/id-registry.json tsx src/seed.ts
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getDb, initDb, closeDb, type SqlQuery } from "./db.js";

interface Registry {
  _nextId: number;
  entities: Record<string, string>; // "E123" -> "slug"
}

async function seed() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const registryPath =
    process.env.ID_REGISTRY_PATH ||
    resolve(__dirname, "../../data/id-registry.json");

  console.log(`Reading registry from: ${registryPath}`);

  const raw = readFileSync(registryPath, "utf-8");
  const registry: Registry = JSON.parse(raw);

  const entries = Object.entries(registry.entities);
  console.log(`Found ${entries.length} entries to seed`);

  const db = getDb();

  // Ensure tables exist
  await initDb();

  let inserted = 0;
  let skipped = 0;
  let maxId = 0;

  // Insert in batches within a transaction
  // Cast tx: TransactionSql's Omit drops Sql's call signatures (TS limitation)
  await db.begin(async (tx) => {
    const q = tx as unknown as SqlQuery;
    for (const [numericIdStr, slug] of entries) {
      const numericId = parseInt(numericIdStr.slice(1), 10);
      if (isNaN(numericId)) {
        console.warn(`  Skipping invalid ID: ${numericIdStr}`);
        skipped++;
        continue;
      }

      if (numericId > maxId) maxId = numericId;

      const result = await q`
        INSERT INTO entity_ids (numeric_id, slug)
        VALUES (${numericId}, ${slug})
        ON CONFLICT (slug) DO NOTHING
      `;

      if (result.count > 0) {
        inserted++;
      } else {
        skipped++;
      }
    }

    // Advance the sequence past the max existing ID
    if (maxId > 0) {
      await q`SELECT setval('entity_id_seq', ${maxId})`;
      console.log(
        `Sequence set to ${maxId} — next allocation will be E${maxId + 1}`
      );
    }
  });

  console.log(`Seed complete: ${inserted} inserted, ${skipped} skipped`);

  await closeDb();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
