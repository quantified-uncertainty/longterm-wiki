/**
 * seed-edit-logs.ts — Migration: populate edit_logs table from YAML files
 *
 * Reads all data/edit-logs/*.yaml files and inserts them into the PostgreSQL
 * edit_logs table. Safe to re-run: uses a transaction that truncates and
 * re-inserts (idempotent full sync).
 *
 * Usage:
 *   DATABASE_URL=... tsx src/seed-edit-logs.ts
 *   DATABASE_URL=... tsx src/seed-edit-logs.ts --dry-run
 */

import { readdirSync, readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { sql } from "drizzle-orm";
import { getDrizzleDb, initDb, closeDb } from "./db.js";
import { editLogs } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface YamlEntry {
  date: string | Date;
  tool: string;
  agency: string;
  requestedBy?: string;
  note?: string;
}

function normalizeDate(d: string | Date): string {
  if (d instanceof Date) return d.toISOString().split("T")[0];
  return String(d);
}

async function seedEditLogs() {
  const dryRun = process.argv.includes("--dry-run");
  const editLogsDir =
    process.env.EDIT_LOGS_DIR ||
    resolve(__dirname, "../../../data/edit-logs");

  console.log(`Reading edit logs from: ${editLogsDir}`);
  if (dryRun) console.log("DRY RUN — no database changes will be made\n");

  const files = readdirSync(editLogsDir).filter((f) => f.endsWith(".yaml"));
  console.log(`Found ${files.length} YAML files\n`);

  let totalEntries = 0;
  let errorFiles = 0;
  const allEntries: Array<{
    pageId: string;
    date: string;
    tool: string;
    agency: string;
    requestedBy: string | null;
    note: string | null;
  }> = [];

  for (const file of files) {
    const pageId = file.replace(/\.yaml$/, "");
    const filePath = join(editLogsDir, file);

    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = parseYaml(raw);

      if (!Array.isArray(parsed)) {
        console.warn(`  WARN: ${file} — not an array, skipping`);
        errorFiles++;
        continue;
      }

      for (const entry of parsed as YamlEntry[]) {
        allEntries.push({
          pageId,
          date: normalizeDate(entry.date),
          tool: String(entry.tool),
          agency: String(entry.agency),
          requestedBy: entry.requestedBy != null ? String(entry.requestedBy) : null,
          note: entry.note != null ? String(entry.note) : null,
        });
        totalEntries++;
      }
    } catch (err) {
      console.warn(`  ERROR: ${file} — ${err}`);
      errorFiles++;
    }
  }

  console.log(
    `Parsed ${totalEntries} entries from ${files.length - errorFiles} files` +
      (errorFiles > 0 ? ` (${errorFiles} files had errors)` : "")
  );

  if (dryRun) {
    console.log("\nDry run summary:");
    console.log(`  Total entries: ${totalEntries}`);
    console.log(`  Pages: ${new Set(allEntries.map((e) => e.pageId)).size}`);

    const toolCounts: Record<string, number> = {};
    const agencyCounts: Record<string, number> = {};
    for (const e of allEntries) {
      toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
      agencyCounts[e.agency] = (agencyCounts[e.agency] || 0) + 1;
    }
    console.log("  By tool:", toolCounts);
    console.log("  By agency:", agencyCounts);
    return;
  }

  // Insert into database using Drizzle batch inserts
  await initDb();
  const db = getDrizzleDb();

  const BATCH_SIZE = 500;
  let inserted = 0;

  await db.transaction(async (tx) => {
    // Truncate for idempotent re-runs
    await tx.execute(sql`TRUNCATE edit_logs RESTART IDENTITY`);
    console.log("Truncated edit_logs table");

    // Insert in batches of 500
    for (let i = 0; i < allEntries.length; i += BATCH_SIZE) {
      const batch = allEntries.slice(i, i + BATCH_SIZE);
      await tx.insert(editLogs).values(batch);
      inserted += batch.length;

      if (i + BATCH_SIZE < allEntries.length) {
        console.log(`  Inserted ${inserted} / ${allEntries.length}...`);
      }
    }
  });

  console.log(`\nSeed complete: ${inserted} entries inserted`);

  await closeDb();
}

seedEditLogs().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
