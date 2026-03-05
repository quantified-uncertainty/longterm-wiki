import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { StatCard } from "@components/internal/StatCard";
import { StatementScoresTable } from "./statement-scores-table";

// ── Types ─────────────────────────────────────────────────────────────────

export interface CoverageScoreRow {
  id: number;
  entityId: string;
  coverageScore: number;
  categoryScores: Record<string, number>;
  statementCount: number;
  qualityAvg: number | null;
  scoredAt: string;
}

export interface ScoreBucket {
  range: string;
  count: number;
}

export interface CategoryBreakdown {
  category: string;
  count: number;
  avgQuality: number | null;
}

interface DistributionData {
  buckets: ScoreBucket[];
  averageQuality: number | null;
  scoredCount: number;
  categoryBreakdown: CategoryBreakdown[];
}

interface StatsResponse {
  total: number;
  byVariety: Record<string, number>;
  byStatus: Record<string, number>;
  propertiesCount: number;
}

// ── Data Loading ──────────────────────────────────────────────────────────

interface DashboardData {
  coverageScores: CoverageScoreRow[];
  distribution: DistributionData;
  stats: StatsResponse;
}

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const [coverageResult, distributionResult, statsResult] = await Promise.all([
    fetchDetailed<{ scores: CoverageScoreRow[]; total: number }>(
      "/api/statements/coverage-scores/all",
      { revalidate: 300 }
    ),
    fetchDetailed<DistributionData>(
      "/api/statements/scores/distribution",
      { revalidate: 300 }
    ),
    fetchDetailed<StatsResponse>(
      "/api/statements/stats",
      { revalidate: 300 }
    ),
  ]);

  if (!coverageResult.ok) return coverageResult;
  if (!distributionResult.ok) return distributionResult;
  if (!statsResult.ok) return statsResult;

  return {
    ok: true,
    data: {
      coverageScores: coverageResult.data.scores,
      distribution: distributionResult.data,
      stats: statsResult.data,
    },
  };
}

function noLocalFallback(): DashboardData {
  return {
    coverageScores: [],
    distribution: {
      buckets: [],
      averageQuality: null,
      scoredCount: 0,
      categoryBreakdown: [],
    },
    stats: { total: 0, byVariety: {}, byStatus: {}, propertiesCount: 0 },
  };
}

// ── Bar Chart Component ─────────────────────────────────────────────────

function QualityDistributionChart({ buckets }: { buckets: ScoreBucket[] }) {
  const scoredBuckets = buckets.filter((b) => b.range !== "unscored");
  const maxCount = Math.max(...scoredBuckets.map((b) => b.count), 1);

  if (scoredBuckets.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 p-6 text-center text-muted-foreground">
        <p className="text-sm">No scored statements yet.</p>
      </div>
    );
  }

  const barColors: Record<string, string> = {
    "0.0-0.2": "bg-red-400 dark:bg-red-600",
    "0.2-0.4": "bg-orange-400 dark:bg-orange-600",
    "0.4-0.6": "bg-yellow-400 dark:bg-yellow-600",
    "0.6-0.8": "bg-emerald-400 dark:bg-emerald-600",
    "0.8-1.0": "bg-green-500 dark:bg-green-600",
  };

  return (
    <div className="rounded-lg border border-border/60 p-4">
      <h3 className="text-sm font-medium mb-3">Quality Score Distribution</h3>
      <div className="flex items-end gap-2 h-32">
        {scoredBuckets.map((bucket) => {
          const heightPct = (bucket.count / maxCount) * 100;
          const color = barColors[bucket.range] ?? "bg-blue-400";
          return (
            <div key={bucket.range} className="flex-1 flex flex-col items-center gap-1">
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {bucket.count}
              </span>
              <div className="w-full relative" style={{ height: "100px" }}>
                <div
                  className={`absolute bottom-0 w-full rounded-t ${color}`}
                  style={{ height: `${heightPct}%`, minHeight: bucket.count > 0 ? "4px" : "0" }}
                />
              </div>
              <span className="text-[10px] tabular-nums text-muted-foreground whitespace-nowrap">
                {bucket.range}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Category Breakdown ──────────────────────────────────────────────────

function CategoryBreakdownTable({ categories }: { categories: CategoryBreakdown[] }) {
  if (categories.length === 0) {
    return (
      <div className="rounded-lg border border-border/60 p-6 text-center text-muted-foreground">
        <p className="text-sm">No category data available.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/60 p-4">
      <h3 className="text-sm font-medium mb-3">Category Breakdown</h3>
      <div className="space-y-2">
        {categories.map((cat) => {
          const maxCount = Math.max(...categories.map((c) => c.count), 1);
          const widthPct = (cat.count / maxCount) * 100;
          return (
            <div key={cat.category} className="flex items-center gap-2">
              <span className="text-xs w-28 truncate text-muted-foreground" title={cat.category}>
                {cat.category}
              </span>
              <div className="flex-1 h-5 bg-muted/30 rounded relative overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-blue-400/60 dark:bg-blue-600/60 rounded"
                  style={{ width: `${widthPct}%` }}
                />
                <span className="absolute inset-0 flex items-center px-2 text-[11px] tabular-nums font-medium">
                  {cat.count}
                </span>
              </div>
              <span className="text-xs tabular-nums w-12 text-right text-muted-foreground">
                {cat.avgQuality != null ? `${(cat.avgQuality * 100).toFixed(0)}%` : "--"}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-muted-foreground mt-2">
        Right column: average quality score per category
      </p>
    </div>
  );
}

// ── Content Component ────────────────────────────────────────────────────

export async function StatementScoresContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback
  );

  const { coverageScores, distribution, stats } = data;

  const unscored = distribution.buckets.find((b) => b.range === "unscored");
  const unscoredCount = unscored?.count ?? 0;
  const scoredCount = distribution.scoredCount;
  const scorePct = stats.total > 0
    ? Math.round((scoredCount / stats.total) * 100)
    : 0;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Quality scoring dashboard for the Statements system. Shows entity
        coverage scores, quality score distribution, and per-category
        breakdowns. Quality scores range from 0 to 1 across 10 dimensions.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-4">
        <StatCard label="Total Statements" value={stats.total} />
        <StatCard label="Scored" value={scoredCount} color="emerald" />
        <StatCard label="Unscored" value={unscoredCount} color="amber" />
        <StatCard label="Entities Scored" value={coverageScores.length} color="blue" />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="rounded-lg border border-border/60 px-3 py-2">
          <p className="text-xs text-muted-foreground">Scoring Coverage</p>
          <p className="text-lg font-semibold tabular-nums text-foreground">
            {scorePct}%
          </p>
        </div>
        <div className="rounded-lg border border-border/60 px-3 py-2">
          <p className="text-xs text-muted-foreground">Avg Quality</p>
          <p className="text-lg font-semibold tabular-nums text-foreground">
            {distribution.averageQuality != null
              ? `${(distribution.averageQuality * 100).toFixed(1)}%`
              : "--"}
          </p>
        </div>
        <StatCard label="Properties" value={stats.propertiesCount} />
        <StatCard label="Categories" value={distribution.categoryBreakdown.length} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <QualityDistributionChart buckets={distribution.buckets} />
        <CategoryBreakdownTable categories={distribution.categoryBreakdown} />
      </div>

      {coverageScores.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No coverage scores yet</p>
          <p className="text-sm">
            Coverage scores are computed by the statement scoring pipeline via{" "}
            <code className="text-xs">pnpm crux statements score</code>.
          </p>
        </div>
      ) : (
        <StatementScoresTable data={coverageScores} />
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}
