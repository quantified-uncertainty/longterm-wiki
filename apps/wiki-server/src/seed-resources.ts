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
import { sql } from "drizzle-orm";
import { getDrizzleDb, initDb, closeDb } from "./db.js";
import { resources, resourceCitations } from "./schema.js";

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

function normalizeTimestamp(d: string | Date | undefined): Date | null {
  if (!d) return null;
  if (d instanceof Date) return d;
  // Handle "YYYY-MM-DD HH:MM:SS" format
  const str = String(d);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) {
    return new Date(str.replace(" ", "T") + "Z");
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return new Date(str + "T00:00:00Z");
  }
  return new Date(str);
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

  // Insert into database using Drizzle batch inserts
  await initDb();
  const db = getDrizzleDb();

  const BATCH_SIZE = 500;
  let insertedResources = 0;
  let insertedCitations = 0;

  await db.transaction(async (tx) => {
    // Truncate for idempotent re-runs
    await tx.execute(sql`TRUNCATE resource_citations`);
    await tx.execute(sql`TRUNCATE resources CASCADE`);
    console.log("Truncated resources and resource_citations tables");

    // Batch insert resources
    for (let i = 0; i < allResources.length; i += BATCH_SIZE) {
      const batch = allResources.slice(i, i + BATCH_SIZE);
      await tx.insert(resources).values(
        batch.map((r) => ({
          id: r.id,
          url: r.url,
          title: r.title || null,
          type: r.type || null,
          summary: r.summary || null,
          review: r.review || null,
          abstract: r.abstract || null,
          keyPoints: r.key_points ?? null,
          publicationId: r.publication_id || null,
          authors: r.authors ?? null,
          publishedDate: normalizeDate(r.published_date),
          tags: r.tags ?? null,
          localFilename: r.local_filename || null,
          credibilityOverride: r.credibility_override ?? null,
          fetchedAt: normalizeTimestamp(r.fetched_at),
          contentHash: r.content_hash || null,
        }))
      );
      insertedResources += batch.length;

      if (i + BATCH_SIZE < allResources.length) {
        console.log(
          `  Inserted ${insertedResources} / ${allResources.length} resources...`
        );
      }
    }

    // Collect and batch insert all citations
    const allCitations: Array<{ resourceId: string; pageId: string }> = [];
    for (const r of allResources) {
      if (r.cited_by) {
        for (const pageId of r.cited_by) {
          allCitations.push({ resourceId: r.id, pageId });
        }
      }
    }

    for (let i = 0; i < allCitations.length; i += BATCH_SIZE) {
      const batch = allCitations.slice(i, i + BATCH_SIZE);
      await tx.insert(resourceCitations).values(batch);
      insertedCitations += batch.length;
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
