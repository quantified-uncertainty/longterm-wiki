import fs from "fs";
import path from "path";
import { loadYaml } from "@lib/yaml";
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

// ── API Data Loading ──────────────────────────────────────────────────────

interface ApiRunEntry {
  id: number;
  date: string;
  startedAt: string;
  completedAt: string | null;
  trigger: string;
  budgetLimit: number | null;
  budgetSpent: number | null;
  sourcesChecked: number | null;
  sourcesFailed: number | null;
  itemsFetched: number | null;
  itemsRelevant: number | null;
  pagesPlanned: number | null;
  pagesUpdated: number | null;
  pagesFailed: number | null;
  pagesSkipped: number | null;
  results: Array<{
    pageId: string;
    status: string;
    tier: string | null;
    durationMs: number | null;
    errorMessage: string | null;
  }>;
}

async function loadRunsFromApi(): Promise<RunRow[] | null> {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
  if (!serverUrl) return null;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetch(`${serverUrl}/api/auto-update-runs/all?limit=200`, {
      headers,
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { entries: ApiRunEntry[] };
    return data.entries.map((r) => {
      const startMs = new Date(r.startedAt).getTime();
      const endMs = r.completedAt ? new Date(r.completedAt).getTime() : startMs;

      return {
        date: r.date,
        startedAt: r.startedAt,
        trigger: r.trigger || "manual",
        sourcesChecked: r.sourcesChecked ?? 0,
        sourcesFailed: r.sourcesFailed ?? 0,
        itemsFetched: r.itemsFetched ?? 0,
        itemsRelevant: r.itemsRelevant ?? 0,
        pagesPlanned: r.pagesPlanned ?? 0,
        pagesUpdated: r.pagesUpdated ?? 0,
        pagesFailed: r.pagesFailed ?? 0,
        pagesSkipped: r.pagesSkipped ?? 0,
        budgetLimit: r.budgetLimit ?? 0,
        budgetSpent: r.budgetSpent ?? 0,
        durationMinutes: Math.round((endMs - startMs) / 60000),
        results: r.results.map((res) => ({
          pageId: res.pageId,
          status: res.status as "success" | "failed" | "skipped",
          tier: res.tier || "",
          error: res.errorMessage ?? undefined,
          durationMs: res.durationMs ?? undefined,
        })),
      };
    });
  } catch {
    return null;
  }
}

// ── YAML Fallback ─────────────────────────────────────────────────────────

function loadRunReportsFromYaml(): RunRow[] {
  const runsDir = path.resolve(process.cwd(), "../../data/auto-update/runs");
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
      const report = loadYaml<RunReport>(raw);
      const startMs = new Date(report.startedAt).getTime();
      const endMs = new Date(report.completedAt).getTime();

      rows.push({
        date: report.date,
        startedAt: report.startedAt,
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

// ── Page Component ────────────────────────────────────────────────────────

export default async function AutoUpdateRunsPage() {
  // Try API first, fall back to YAML
  const apiRuns = await loadRunsFromApi();
  const runs = apiRuns ?? loadRunReportsFromYaml();
  const dataSource = apiRuns ? "wiki-server" : "local fallback";

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
      <p className="text-xs text-muted-foreground">
        Data source: {dataSource}.
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
