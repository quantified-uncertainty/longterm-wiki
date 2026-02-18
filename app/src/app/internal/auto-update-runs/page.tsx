import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { RunsTable } from "./runs-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Auto-Update Runs | Longterm Wiki Internal",
  description:
    "History of news-driven auto-update runs, budget tracking, and source health.",
};

interface RunReport {
  date: string;
  startedAt: string;
  completedAt: string;
  trigger: "scheduled" | "manual";
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
    results: Array<{
      pageId: string;
      status: "success" | "failed" | "skipped";
      tier: string;
      error?: string;
      durationMs?: number;
    }>;
  };
  newPagesCreated: string[];
}

export interface RunRow {
  date: string;
  startedAt: string;
  trigger: string;
  sourcesChecked: number;
  sourcesFailed: number;
  itemsFetched: number;
  itemsRelevant: number;
  pagesPlanned: number;
  pagesUpdated: number;
  pagesFailed: number;
  pagesSkipped: number;
  budgetLimit: number;
  budgetSpent: number;
  durationMinutes: number;
  results: RunReport["execution"]["results"];
}

/** js-yaml parses bare dates (e.g. 2026-02-18) as Date objects. Coerce to string. */
function str(val: unknown): string {
  if (val instanceof Date) return val.toISOString();
  return String(val ?? "");
}

function loadRunReports(): RunRow[] {
  const runsDir = path.resolve(process.cwd(), "../data/auto-update/runs");
  if (!fs.existsSync(runsDir)) return [];

  const files = fs
    .readdirSync(runsDir)
    .filter((f) => f.endsWith(".yaml") && !f.includes("-details"))
    .sort()
    .reverse();

  const rows: RunRow[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(runsDir, file), "utf-8");
      const report = yaml.load(raw) as RunReport;
      const startMs = new Date(str(report.startedAt)).getTime();
      const endMs = new Date(str(report.completedAt)).getTime();

      rows.push({
        date: str(report.date).slice(0, 10),
        startedAt: str(report.startedAt),
        trigger: report.trigger || "manual",
        sourcesChecked: report.digest.sourcesChecked,
        sourcesFailed: report.digest.sourcesFailed,
        itemsFetched: report.digest.itemsFetched,
        itemsRelevant: report.digest.itemsRelevant,
        pagesPlanned: report.plan.pagesPlanned,
        pagesUpdated: report.execution.pagesUpdated,
        pagesFailed: report.execution.pagesFailed,
        pagesSkipped: report.execution.pagesSkipped,
        budgetLimit: report.budget.limit,
        budgetSpent: report.budget.spent,
        durationMinutes: Math.round((endMs - startMs) / 60000),
        results: report.execution.results,
      });
    } catch {
      /* skip malformed files */
    }
  }

  return rows;
}

export default function AutoUpdateRunsPage() {
  const runs = loadRunReports();

  const totalSpent = runs.reduce((sum, r) => sum + r.budgetSpent, 0);
  const totalUpdated = runs.reduce((sum, r) => sum + r.pagesUpdated, 0);
  const totalFailed = runs.reduce((sum, r) => sum + r.pagesFailed, 0);

  return (
    <article className="prose max-w-none">
      <h1>Auto-Update Runs</h1>
      <p className="text-muted-foreground">
        History of news-driven auto-update pipeline runs.{" "}
        {runs.length > 0 ? (
          <>
            <span className="font-medium text-foreground">{runs.length}</span>{" "}
            runs,{" "}
            <span className="font-medium text-foreground">{totalUpdated}</span>{" "}
            pages updated, \${totalSpent.toFixed(0)} spent.
            {totalFailed > 0 && (
              <span className="text-red-500 font-medium">
                {" "}
                {totalFailed} failures.
              </span>
            )}
          </>
        ) : (
          <>
            No runs yet. Run{" "}
            <code className="text-xs">pnpm crux auto-update run</code> to start
            the pipeline.
          </>
        )}
      </p>

      {runs.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No auto-update runs yet</p>
          <p className="text-sm">
            The auto-update pipeline runs daily via GitHub Actions or manually
            via <code className="text-xs">pnpm crux auto-update run</code>.
            Run reports will appear here once the first run completes.
          </p>
          <p className="text-sm mt-2">
            Preview what would happen:{" "}
            <code className="text-xs">pnpm crux auto-update plan</code>
          </p>
        </div>
      ) : (
        <RunsTable data={runs} />
      )}
    </article>
  );
}
