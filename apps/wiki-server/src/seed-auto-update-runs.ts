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
import { getDb, initDb, closeDb, type SqlQuery } from "./db.js";

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

  // Insert into database
  const db = getDb();
  await initDb();

  let runsInserted = 0;
  let resultsInserted = 0;

  await db.begin(async (tx) => {
    const q = tx as unknown as SqlQuery;

    // Truncate for idempotent re-runs
    await q`TRUNCATE auto_update_results RESTART IDENTITY`;
    await q`TRUNCATE auto_update_runs RESTART IDENTITY CASCADE`;
    console.log("Truncated auto_update_runs and auto_update_results tables");

    for (const { run, results } of allRuns) {
      const rows = await q`
        INSERT INTO auto_update_runs (
          date, started_at, completed_at, trigger,
          budget_limit, budget_spent,
          sources_checked, sources_failed, items_fetched, items_relevant,
          pages_planned, pages_updated, pages_failed, pages_skipped,
          new_pages_created
        )
        VALUES (
          ${run.date}::date,
          ${run.startedAt}::timestamptz,
          ${run.completedAt}::timestamptz,
          ${run.trigger},
          ${run.budgetLimit}, ${run.budgetSpent},
          ${run.sourcesChecked}, ${run.sourcesFailed},
          ${run.itemsFetched}, ${run.itemsRelevant},
          ${run.pagesPlanned}, ${run.pagesUpdated},
          ${run.pagesFailed}, ${run.pagesSkipped},
          ${run.newPagesCreated || null}
        )
        RETURNING id
      `;
      const runId = (rows as any)[0].id;
      runsInserted++;

      for (const result of results) {
        await q`
          INSERT INTO auto_update_results (run_id, page_id, status, tier, duration_ms, error_message)
          VALUES (
            ${runId}, ${result.pageId}, ${result.status},
            ${result.tier ?? null}, ${result.durationMs ?? null},
            ${result.error ?? null}
          )
        `;
        resultsInserted++;
      }
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
