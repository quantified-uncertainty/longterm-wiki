import { fetchDetailed, withApiFallback } from "@/lib/wiki-server";
import { DataSourceBanner } from "@/components/internal/DataSourceBanner";
import { InsightsTable } from "./insights-table";

export type InsightRow = {
  date: string | null;
  branch: string | null;
  title: string | null;
  type: "learning" | "recommendation";
  text: string;
};

type InsightsResponse = {
  insights: InsightRow[];
  summary: { total: number; byType: Record<string, number> };
};

async function loadFromApi() {
  return fetchDetailed<InsightsResponse>("/api/agent-sessions/insights", {
    revalidate: 60,
  });
}

function noLocalFallback(): null {
  return null;
}

export async function SessionInsightsContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback,
  );

  const insights =
    data && typeof data === "object" && "insights" in data
      ? (data as InsightsResponse).insights
      : [];
  const summary =
    data && typeof data === "object" && "summary" in data
      ? (data as InsightsResponse).summary
      : null;

  return (
    <>
      <p className="text-muted-foreground">
        Learnings and recommendations extracted from agent sessions.
        {summary && ` ${summary.total} total insights.`}
      </p>

      {summary && summary.total > 0 && (
        <div className="not-prose flex gap-4 mb-6">
          {Object.entries(summary.byType).map(([type, count]) => (
            <div
              key={type}
              className="rounded-lg border border-border/60 px-4 py-2"
            >
              <div className="text-2xl font-bold tabular-nums">{count}</div>
              <div className="text-xs text-muted-foreground capitalize">
                {type}s
              </div>
            </div>
          ))}
        </div>
      )}

      {insights.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No insights recorded yet</p>
          <p className="text-sm">
            Insights are extracted from agent session logs. Run sessions with
            learnings/recommendations to populate this dashboard.
          </p>
        </div>
      ) : (
        <InsightsTable data={insights} />
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}
