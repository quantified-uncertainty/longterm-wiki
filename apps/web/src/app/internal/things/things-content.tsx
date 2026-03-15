import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { ThingsTable } from "./things-table";

// ── Types ─────────────────────────────────────────────────────────────────

interface ThingsStatsResult {
  total: number;
  byType: Record<string, number>;
  byVerdict: Record<string, number>;
  byEntityType: Record<string, number>;
}

// ── Data Loading ──────────────────────────────────────────────────────────

async function loadStats(): Promise<FetchResult<ThingsStatsResult>> {
  return fetchDetailed<ThingsStatsResult>("/api/things/stats", { revalidate: 60 });
}

function emptyStats(): ThingsStatsResult {
  return { total: 0, byType: {}, byVerdict: {}, byEntityType: {} };
}

// ── Stats Card ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="bg-card border rounded-lg p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

export async function ThingsContent() {
  const { data: stats, source, apiError } = await withApiFallback(loadStats, emptyStats);

  const withVerdict = Object.entries(stats.byVerdict)
    .filter(([v]) => v !== "unchecked")
    .reduce((sum, [, c]) => sum + c, 0);

  return (
    <>
      <DataSourceBanner source={source} apiError={apiError} />

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Things" value={stats.total.toLocaleString()} />
        <StatCard
          label="Types"
          value={Object.keys(stats.byType).length}
          sub={Object.entries(stats.byType)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([t, c]) => `${t}: ${c}`)
            .join(", ")}
        />
        <StatCard
          label="With Verdicts"
          value={withVerdict}
          sub={
            stats.total > 0
              ? `${((withVerdict / stats.total) * 100).toFixed(1)}% of total`
              : undefined
          }
        />
        <StatCard
          label="Entity Types"
          value={Object.keys(stats.byEntityType).length}
          sub={Object.entries(stats.byEntityType)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([t, c]) => `${t}: ${c}`)
            .join(", ")}
        />
      </div>

      {/* Type breakdown */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-3">By Type</h2>
        <div className="flex flex-wrap gap-2">
          {Object.entries(stats.byType)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => (
              <div
                key={type}
                className="bg-card border rounded-md px-3 py-2 text-sm"
              >
                <span className="font-medium">{type}</span>
                <span className="text-muted-foreground ml-2">
                  {count.toLocaleString()}
                </span>
              </div>
            ))}
        </div>
      </div>

      {/* Verdict breakdown */}
      {Object.keys(stats.byVerdict).length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Verification Status</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.byVerdict)
              .sort(([, a], [, b]) => b - a)
              .map(([verdict, count]) => (
                <div
                  key={verdict}
                  className="bg-card border rounded-md px-3 py-2 text-sm"
                >
                  <span className="font-medium">{verdict}</span>
                  <span className="text-muted-foreground ml-2">
                    {count.toLocaleString()}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Things table — fetches pages via server actions */}
      <div>
        <h2 className="text-lg font-semibold mb-3">All Things</h2>
        <ThingsTable total={stats.total} typeCounts={stats.byType} />
      </div>
    </>
  );
}
