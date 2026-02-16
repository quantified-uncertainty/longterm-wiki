/**
 * Seed the Postgres database from existing YAML/MDX source files.
 *
 * Imports:
 *   1. Entity numeric IDs (from data/entities/*.yaml + MDX frontmatter)
 *   2. Edit logs (from data/edit-logs/*.yaml)
 *
 * Safe to re-run — uses ON CONFLICT DO NOTHING for entity IDs and
 * truncates edit_logs before re-inserting (no natural unique key).
 *
 * Usage:
 *   pnpm --filter longterm-wiki-server db:seed
 *   # or from server/:
 *   pnpm db:seed
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { parse as parseYaml } from "yaml";
import matter from "gray-matter";
import { db, sql } from "./db.ts";
import { entityIds, editLogs } from "./schema.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const CONTENT_DIR = join(PROJECT_ROOT, "content/docs");

// ---------------------------------------------------------------------------
// 1. Seed entity IDs
// ---------------------------------------------------------------------------

interface IdEntry {
  numericId: number;
  slug: string;
  entityType?: string;
  title?: string;
}

async function collectEntityIds(): Promise<IdEntry[]> {
  const entries: IdEntry[] = [];
  const seen = new Set<number>();

  // --- From YAML entity files ---
  const entityDir = join(DATA_DIR, "entities");
  if (existsSync(entityDir)) {
    for (const file of readdirSync(entityDir).filter((f) =>
      f.endsWith(".yaml"),
    )) {
      const raw = readFileSync(join(entityDir, file), "utf-8");
      const parsed = parseYaml(raw);
      if (!Array.isArray(parsed)) continue;

      for (const entity of parsed) {
        if (entity.numericId && entity.id) {
          const n = parseInt(String(entity.numericId).replace(/^E/, ""));
          if (!isNaN(n) && !seen.has(n)) {
            seen.add(n);
            entries.push({
              numericId: n,
              slug: entity.id,
              entityType: entity.type ?? null,
              title: entity.title ?? null,
            });
          }
        }
      }
    }
  }

  // --- From MDX frontmatter ---
  function walkMdx(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkMdx(full);
      } else if (entry.name.endsWith(".mdx")) {
        try {
          const raw = readFileSync(full, "utf-8");
          const { data } = matter(raw);
          if (data.numericId) {
            const n = parseInt(String(data.numericId).replace(/^E/, ""));
            const slug =
              data.entityId ?? basename(entry.name, ".mdx");
            if (!isNaN(n) && !seen.has(n)) {
              seen.add(n);
              entries.push({
                numericId: n,
                slug,
                entityType: data.entityType ?? null,
                title: data.title ?? null,
              });
            }
          }
        } catch {
          // Skip files with parse errors
        }
      }
    }
  }
  walkMdx(CONTENT_DIR);

  return entries.sort((a, b) => a.numericId - b.numericId);
}

async function seedEntityIds() {
  const entries = await collectEntityIds();
  console.log(`Found ${entries.length} entity IDs to seed.`);

  if (entries.length === 0) return;

  // Batch insert with ON CONFLICT DO NOTHING
  let inserted = 0;
  const BATCH = 200;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const result = await db
      .insert(entityIds)
      .values(batch)
      .onConflictDoNothing()
      .returning();
    inserted += result.length;
  }

  console.log(`  Inserted ${inserted} new entity IDs (${entries.length - inserted} already existed).`);

  // Set the sequence to max(seeded IDs, existing DB IDs) so it never goes backwards
  const maxSeeded = entries[entries.length - 1].numericId;
  await sql`SELECT setval('entity_id_seq', GREATEST(${maxSeeded}, COALESCE((SELECT MAX(numeric_id) FROM entity_ids), 0)))`;
  console.log(`  Sequence set to start after E${maxSeeded} (or higher if DB has later IDs).`);
}

// ---------------------------------------------------------------------------
// 2. Seed edit logs
// ---------------------------------------------------------------------------

async function seedEditLogs() {
  const editLogDir = join(DATA_DIR, "edit-logs");
  if (!existsSync(editLogDir)) {
    console.log("No edit-logs directory found, skipping.");
    return;
  }

  // Truncate before re-seeding to avoid duplicates (edit_logs has no natural
  // unique key, so ON CONFLICT can't deduplicate).
  await sql`TRUNCATE edit_logs RESTART IDENTITY`;

  const files = readdirSync(editLogDir).filter((f) => f.endsWith(".yaml"));
  console.log(`Found ${files.length} edit-log files to seed.`);

  let total = 0;
  for (const file of files) {
    const pageId = basename(file, ".yaml");
    const raw = readFileSync(join(editLogDir, file), "utf-8");
    const parsed = parseYaml(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) continue;

    const values = parsed.map((entry: Record<string, unknown>) => ({
      pageId,
      date:
        entry.date instanceof Date
          ? entry.date.toISOString().split("T")[0]
          : String(entry.date),
      tool: String(entry.tool),
      agency: String(entry.agency),
      requestedBy: entry.requestedBy ? String(entry.requestedBy) : null,
      note: entry.note ? String(entry.note) : null,
    }));

    await db.insert(editLogs).values(values);
    total += values.length;
  }

  console.log(`  Inserted ${total} edit-log entries.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("Seeding database from YAML/MDX sources…\n");
await seedEntityIds();
console.log();
await seedEditLogs();
console.log("\nDone.");
await sql.end();
