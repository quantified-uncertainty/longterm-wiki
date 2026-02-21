/**
 * seed-resources.ts — Migration: populate resources + resource_citations tables from YAML
 *
 * Reads all data/resources/*.yaml files and inserts them into the PostgreSQL
 * resources and resource_citations tables. Safe to re-run: uses a transaction
 * that truncates and re-inserts (idempotent full sync).
 *
 * Usage:
 *   DATABASE_URL=... tsx src/seed-resources.ts
 *   DATABASE_URL=... tsx src/seed-resources.ts --dry-run
 */

import { readdirSync, readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { getDb, initDb, closeDb, type SqlQuery } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface YamlResource {
  id: string;
  url: string;
  title?: string;
  type?: string;
  summary?: string;
  review?: string;
  abstract?: string;
  key_points?: string[];
  publication_id?: string;
  authors?: string[];
  published_date?: string | Date;
  tags?: string[];
  local_filename?: string;
  credibility_override?: number;
  fetched_at?: string | Date;
  content_hash?: string;
  cited_by?: string[];
}

function normalizeDate(d: string | Date | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().split("T")[0];
  // Handle "YYYY-MM-DD HH:MM:SS" format from YAML
  const dateStr = String(d).split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  return null;
}

function normalizeTimestamp(d: string | Date | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  // Handle "YYYY-MM-DD HH:MM:SS" format
  const str = String(d);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) {
    return str.replace(" ", "T") + "Z";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str + "T00:00:00Z";
  }
  return str;
}

async function seedResources() {
  const dryRun = process.argv.includes("--dry-run");
  const resourcesDir =
    process.env.RESOURCES_DIR ||
    resolve(__dirname, "../../../data/resources");

  console.log(`Reading resources from: ${resourcesDir}`);
  if (dryRun) console.log("DRY RUN — no database changes will be made\n");

  const files = readdirSync(resourcesDir).filter((f) => f.endsWith(".yaml"));
  console.log(`Found ${files.length} YAML files\n`);

  let totalResources = 0;
  let totalCitations = 0;
  let errorFiles = 0;

  const allResources: YamlResource[] = [];

  for (const file of files) {
    const filePath = join(resourcesDir, file);

    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = parseYaml(raw);

      if (!Array.isArray(parsed)) {
        console.warn(`  WARN: ${file} — not an array, skipping`);
        errorFiles++;
        continue;
      }

      for (const entry of parsed as YamlResource[]) {
        if (!entry.id || !entry.url) {
          console.warn(`  WARN: ${file} — entry missing id or url, skipping`);
          continue;
        }
        allResources.push(entry);
        totalResources++;
        if (entry.cited_by) {
          totalCitations += entry.cited_by.length;
        }
      }
    } catch (err) {
      console.warn(`  ERROR: ${file} — ${err}`);
      errorFiles++;
    }
  }

  console.log(
    `Parsed ${totalResources} resources from ${files.length - errorFiles} files` +
      (errorFiles > 0 ? ` (${errorFiles} files had errors)` : "")
  );
  console.log(`  Citations (cited_by): ${totalCitations}`);

  if (dryRun) {
    console.log("\nDry run summary:");
    console.log(`  Total resources: ${totalResources}`);
    console.log(`  Total citations: ${totalCitations}`);

    const typeCounts: Record<string, number> = {};
    for (const r of allResources) {
      const t = r.type || "unknown";
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }
    console.log("  By type:", typeCounts);

    const withSummary = allResources.filter((r) => r.summary).length;
    const withAuthors = allResources.filter(
      (r) => r.authors && r.authors.length > 0
    ).length;
    console.log(`  With summary: ${withSummary}`);
    console.log(`  With authors: ${withAuthors}`);
    return;
  }

  // Insert into database
  const db = getDb();
  await initDb();

  const BATCH_SIZE = 100;
  let insertedResources = 0;
  let insertedCitations = 0;

  await db.begin(async (tx) => {
    const q = tx as unknown as SqlQuery;

    // Truncate for idempotent re-runs
    await q`TRUNCATE resource_citations`;
    await q`TRUNCATE resources CASCADE`;
    console.log("Truncated resources and resource_citations tables");

    // Insert resources in batches
    for (let i = 0; i < allResources.length; i += BATCH_SIZE) {
      const batch = allResources.slice(i, i + BATCH_SIZE);

      for (const r of batch) {
        const publishedDate = normalizeDate(r.published_date);
        const fetchedAt = normalizeTimestamp(r.fetched_at);

        await q`
          INSERT INTO resources (
            id, url, title, type, summary, review, abstract,
            key_points, publication_id, authors, published_date,
            tags, local_filename, credibility_override, fetched_at, content_hash
          ) VALUES (
            ${r.id}, ${r.url}, ${r.title || null}, ${r.type || null},
            ${r.summary || null}, ${r.review || null}, ${r.abstract || null},
            ${r.key_points ? JSON.stringify(r.key_points) : null}::jsonb,
            ${r.publication_id || null},
            ${r.authors ? JSON.stringify(r.authors) : null}::jsonb,
            ${publishedDate}::date,
            ${r.tags ? JSON.stringify(r.tags) : null}::jsonb,
            ${r.local_filename || null},
            ${r.credibility_override ?? null},
            ${fetchedAt}::timestamptz,
            ${r.content_hash || null}
          )
        `;
        insertedResources++;

        // Insert citations
        if (r.cited_by) {
          for (const pageId of r.cited_by) {
            await q`
              INSERT INTO resource_citations (resource_id, page_id)
              VALUES (${r.id}, ${pageId})
              ON CONFLICT DO NOTHING
            `;
            insertedCitations++;
          }
        }
      }

      if (i + BATCH_SIZE < allResources.length) {
        console.log(
          `  Inserted ${insertedResources} / ${allResources.length} resources...`
        );
      }
    }
  });

  console.log(
    `\nSeed complete: ${insertedResources} resources, ${insertedCitations} citations inserted`
  );

  await closeDb();
}

seedResources().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
