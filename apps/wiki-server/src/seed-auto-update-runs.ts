/**
 * seed-auto-update-runs.ts — Migration: populate auto_update_runs + auto_update_results
 * from YAML files in data/auto-update/runs/.
 *
 * Reads all non-detail YAML files and inserts them into PostgreSQL.
 * Safe to re-run: uses a transaction that truncates and re-inserts (idempotent full sync).
 *
 * Usage:
 *   DATABASE_URL=... tsx src/seed-auto-update-runs.ts
 *   DATABASE_URL=... tsx src/seed-auto-update-runs.ts --dry-run
 */

import { readdirSync, readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { sql } from "drizzle-orm";
import { getDrizzleDb, initDb, closeDb } from "./db.js";
import { autoUpdateRuns, autoUpdateResults } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface YamlRunResult {
  pageId: string;
  status: "success" | "failed" | "skipped";
  tier: string;
  error?: string;
  durationMs?: number;
}

interface YamlRunReport {
  date: string | Date;
  startedAt: string;
  completedAt: string;
  trigger: string;
  budget: { limit: number; spent: number };
  digest: {
    sourcesChecked: number;
    sourcesFailed: number;
    itemsFetched: number;
    itemsRelevant: number;
  };
  plan: {
    pagesPlanned: number;
    newPagesSuggested: number;
  };
  execution: {
    pagesUpdated: number;
    pagesFailed: number;
    pagesSkipped: number;
    results: YamlRunResult[];
  };
  newPagesCreated: string[];
}

function normalizeDate(d: string | Date): string {
  if (d instanceof Date) return d.toISOString().split("T")[0];
  return String(d);
}

async function seedAutoUpdateRuns() {
  const dryRun = process.argv.includes("--dry-run");
  const runsDir =
    process.env.AUTO_UPDATE_RUNS_DIR ||
    resolve(__dirname, "../../../data/auto-update/runs");

  console.log(`Reading auto-update runs from: ${runsDir}`);
  if (dryRun) console.log("DRY RUN — no database changes will be made\n");

  const files = readdirSync(runsDir).filter(
    (f) => f.endsWith(".yaml") && !f.includes("-details")
  );
  console.log(`Found ${files.length} run YAML files\n`);

  let errorFiles = 0;
  const allRuns: Array<{
    run: {
      date: string;
      startedAt: string;
      completedAt: string;
      trigger: string;
      budgetLimit: number;
      budgetSpent: number;
      sourcesChecked: number;
      sourcesFailed: number;
      itemsFetched: number;
      itemsRelevant: number;
      pagesPlanned: number;
      pagesUpdated: number;
      pagesFailed: number;
      pagesSkipped: number;
      newPagesCreated: string;
    };
    results: YamlRunResult[];
  }> = [];

  for (const file of files) {
    const filePath = join(runsDir, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const report = parseYaml(raw) as YamlRunReport;

      allRuns.push({
        run: {
          date: normalizeDate(report.date),
          startedAt: report.startedAt,
          completedAt: report.completedAt,
          trigger: report.trigger || "manual",
          budgetLimit: report.budget?.limit ?? 0,
          budgetSpent: report.budget?.spent ?? 0,
          sourcesChecked: report.digest?.sourcesChecked ?? 0,
          sourcesFailed: report.digest?.sourcesFailed ?? 0,
          itemsFetched: report.digest?.itemsFetched ?? 0,
          itemsRelevant: report.digest?.itemsRelevant ?? 0,
          pagesPlanned: report.plan?.pagesPlanned ?? 0,
          pagesUpdated: report.execution?.pagesUpdated ?? 0,
          pagesFailed: report.execution?.pagesFailed ?? 0,
          pagesSkipped: report.execution?.pagesSkipped ?? 0,
          newPagesCreated: (report.newPagesCreated || []).join(","),
        },
        results: report.execution?.results || [],
      });
    } catch (err) {
      console.warn(`  ERROR: ${file} — ${err}`);
      errorFiles++;
    }
  }

  const totalResults = allRuns.reduce((sum, r) => sum + r.results.length, 0);
  console.log(
    `Parsed ${allRuns.length} runs with ${totalResults} results from ${files.length - errorFiles} files` +
      (errorFiles > 0 ? ` (${errorFiles} files had errors)` : "")
  );

  if (dryRun) {
    console.log("\nDry run summary:");
    console.log(`  Total runs: ${allRuns.length}`);
    console.log(`  Total results: ${totalResults}`);

    const triggerCounts: Record<string, number> = {};
    for (const r of allRuns) {
      triggerCounts[r.run.trigger] = (triggerCounts[r.run.trigger] || 0) + 1;
    }
    console.log("  By trigger:", triggerCounts);
    return;
  }

  // Insert into database using Drizzle batch inserts
  await initDb();
  const db = getDrizzleDb();

  const BATCH_SIZE = 500;
  let runsInserted = 0;
  let resultsInserted = 0;

  await db.transaction(async (tx) => {
    // Truncate for idempotent re-runs
    await tx.execute(sql`TRUNCATE auto_update_results RESTART IDENTITY`);
    await tx.execute(sql`TRUNCATE auto_update_runs RESTART IDENTITY CASCADE`);
    console.log("Truncated auto_update_runs and auto_update_results tables");

    // Batch insert runs, collecting results for second pass
    const allResults: Array<{
      runId: number;
      pageId: string;
      status: string;
      tier: string | null;
      durationMs: number | null;
      errorMessage: string | null;
    }> = [];

    for (let i = 0; i < allRuns.length; i += BATCH_SIZE) {
      const batch = allRuns.slice(i, i + BATCH_SIZE);
      const rows = await tx
        .insert(autoUpdateRuns)
        .values(
          batch.map(({ run }) => ({
            date: run.date,
            startedAt: new Date(run.startedAt),
            completedAt: new Date(run.completedAt),
            trigger: run.trigger,
            budgetLimit: run.budgetLimit,
            budgetSpent: run.budgetSpent,
            sourcesChecked: run.sourcesChecked,
            sourcesFailed: run.sourcesFailed,
            itemsFetched: run.itemsFetched,
            itemsRelevant: run.itemsRelevant,
            pagesPlanned: run.pagesPlanned,
            pagesUpdated: run.pagesUpdated,
            pagesFailed: run.pagesFailed,
            pagesSkipped: run.pagesSkipped,
            newPagesCreated: run.newPagesCreated || null,
          }))
        )
        .returning({ id: autoUpdateRuns.id });

      runsInserted += rows.length;

      // Match returned IDs to input runs (insertion order is preserved)
      for (let j = 0; j < rows.length; j++) {
        for (const result of batch[j].results) {
          allResults.push({
            runId: rows[j].id,
            pageId: result.pageId,
            status: result.status,
            tier: result.tier ?? null,
            durationMs: result.durationMs ?? null,
            errorMessage: result.error ?? null,
          });
        }
      }
    }

    // Batch insert all results
    for (let i = 0; i < allResults.length; i += BATCH_SIZE) {
      const batch = allResults.slice(i, i + BATCH_SIZE);
      await tx.insert(autoUpdateResults).values(batch);
      resultsInserted += batch.length;
    }
  });

  console.log(
    `\nSeed complete: ${runsInserted} runs, ${resultsInserted} results inserted`
  );

  await closeDb();
}

seedAutoUpdateRuns().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
