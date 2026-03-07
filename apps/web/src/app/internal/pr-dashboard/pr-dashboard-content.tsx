import { fetchDetailed, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { PRDashboardBoard } from "./pr-dashboard-board";
import { computeStats, type PullData } from "./pr-dashboard-shared";

// Re-export shared types so existing consumers (mdx-components) keep working
export type { PullData, PRStats, KanbanColumn } from "./pr-dashboard-shared";
export { classifyPR } from "./pr-dashboard-shared";

// ── Data Loading ────────────────────────────────────────────────────────

interface PullsResponse {
  pulls: PullData[];
  error?: string;
}

async function loadFromApi(): Promise<FetchResult<PullsResponse>> {
  return fetchDetailed<PullsResponse>("/api/github/pulls", { revalidate: 15 });
}

function noLocalFallback(): PullsResponse {
  return { pulls: [], error: "Wiki-server unavailable" };
}

// ── Content Component (server) ───────────────────────────────────────────

export async function PRDashboardContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback
  );

  const pulls = data.pulls ?? [];
  const error = data.error ?? undefined;
  const stats = computeStats(pulls);

  return (
    <>
      <DataSourceBanner source={source} apiError={apiError} />
      {error && (
        <div className="border-l-4 border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 mb-4 not-prose">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            {error}
          </p>
        </div>
      )}
      <PRDashboardBoard pulls={pulls} stats={stats} />
    </>
  );
}
