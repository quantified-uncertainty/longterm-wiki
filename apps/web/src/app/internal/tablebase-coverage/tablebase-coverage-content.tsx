import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { getTypedEntityById } from "@data/tablebase";
import { getEntityHref } from "@/data/entity-nav";
import { CoverageTable, type CoverageRow } from "./coverage-table";

// ── Types (match the wiki-server coverage-scans route response shapes) ──

interface CoverageScanItem {
  id: number;
  entityType: string;
  entityId: string;
  coverageScore: number;
  signalsFilled: number;
  signalsTotal: number;
  signals: Record<string, boolean>;
  scannedAt: string;
}

interface AllResponse {
  items: CoverageScanItem[];
  total: number;
}

interface StatRow {
  entityType: string;
  coverageScore: number;
  count: number;
}

interface StatsResponse {
  stats: StatRow[];
}

interface DashboardData {
  items: CoverageScanItem[];
  stats: StatRow[];
}

// ── Data Loading ────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const [allResult, statsResult] = await Promise.all([
    fetchDetailed<AllResponse>("/api/coverage-scans/all?limit=500", {
      revalidate: 60,
    }),
    fetchDetailed<StatsResponse>("/api/coverage-scans/stats", {
      revalidate: 60,
    }),
  ]);

  if (!allResult.ok) return allResult;
  if (!statsResult.ok) return statsResult;

  return {
    ok: true,
    data: {
      items: allResult.data.items,
      stats: statsResult.data.stats,
    },
  };
}

function emptyFallback(): DashboardData {
  return { items: [], stats: [] };
}

// ── Stats computation ────────────────────────────────────────────────

interface TypeStats {
  entityType: string;
  total: number;
  byScore: Record<number, number>;
  avgScore: number;
}

function computeTypeStats(stats: StatRow[]): TypeStats[] {
  const byType = new Map<string, { total: number; byScore: Record<number, number>; sum: number }>();

  for (const row of stats) {
    const existing = byType.get(row.entityType) ?? { total: 0, byScore: {}, sum: 0 };
    existing.total += row.count;
    existing.byScore[row.coverageScore] = (existing.byScore[row.coverageScore] ?? 0) + row.count;
    existing.sum += row.coverageScore * row.count;
    byType.set(row.entityType, existing);
  }

  const result: TypeStats[] = [];
  for (const [entityType, data] of byType) {
    result.push({
      entityType,
      total: data.total,
      byScore: data.byScore,
      avgScore: data.total > 0 ? Math.round((data.sum / data.total) * 100) / 100 : 0,
    });
  }

  result.sort((a, b) => b.total - a.total);
  return result;
}

// ── Coverage Bar ────────────────────────────────────────────────────

const SCORE_COLORS: Record<number, string> = {
  1: "bg-red-500 dark:bg-red-600",
  2: "bg-amber-400 dark:bg-amber-500",
  3: "bg-blue-500 dark:bg-blue-500",
  4: "bg-emerald-500 dark:bg-emerald-500",
};

const SCORE_LABELS: Record<number, string> = {
  1: "Stub",
  2: "Basic",
  3: "Moderate",
  4: "Comprehensive",
};

function CoverageBar({ stats }: { stats: TypeStats }) {
  const { total, byScore } = stats;
  if (total === 0) return null;

  return (
    <div className="flex h-5 w-full rounded-md overflow-hidden">
      {[1, 2, 3, 4].map((score) => {
        const count = byScore[score] ?? 0;
        if (count === 0) return null;
        const pct = (count / total) * 100;
        return (
          <div
            key={score}
            className={`${SCORE_COLORS[score]} flex items-center justify-center text-[10px] font-medium text-white`}
            style={{ width: `${pct}%` }}
            title={`${SCORE_LABELS[score]}: ${count} (${pct.toFixed(1)}%)`}
          >
            {pct >= 8 ? count : ""}
          </div>
        );
      })}
    </div>
  );
}

// ── Content Component ────────────────────────────────────────────────

export async function TablebaseCoverageContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    emptyFallback,
  );

  const { items, stats } = data;
  const typeStats = computeTypeStats(stats);

  // Compute global summary
  const totalEntities = typeStats.reduce((s, t) => s + t.total, 0);
  const globalByScore: Record<number, number> = {};
  for (const ts of typeStats) {
    for (const [score, count] of Object.entries(ts.byScore)) {
      globalByScore[Number(score)] = (globalByScore[Number(score)] ?? 0) + count;
    }
  }
  const globalSum = typeStats.reduce((s, t) => s + t.avgScore * t.total, 0);
  const avgScore = totalEntities > 0 ? Math.round((globalSum / totalEntities) * 100) / 100 : 0;

  // Transform items for enrichment queue table
  const rows: CoverageRow[] = items.map((item) => {
    const entity = getTypedEntityById(item.entityId);
    return {
      entityId: item.entityId,
      entityType: item.entityType,
      title: entity?.title ?? item.entityId,
      coverageScore: item.coverageScore,
      signalsFilled: item.signalsFilled,
      signalsTotal: item.signalsTotal,
      signals: (item.signals ?? {}) as Record<string, boolean>,
      scannedAt: item.scannedAt,
      href: getEntityHref(item.entityId),
    };
  });

  const entityTypes = [...new Set(rows.map((r) => r.entityType))].sort();

  return (
    <>
      <DataSourceBanner source={source} apiError={apiError} />

      <p className="text-muted-foreground text-sm leading-relaxed">
        Coverage scores for {totalEntities.toLocaleString()} entities across{" "}
        {typeStats.length} entity types. Scores range from 1 (stub) to 4
        (comprehensive). Use the enrichment queue below to find entities that
        need more data.
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 my-6">
        <StatCard label="Entities Scanned" value={totalEntities.toLocaleString()} />
        <StatCard label="Average Score" value={avgScore.toFixed(2)} />
        <StatCard label="Stub (Score 1)" value={(globalByScore[1] ?? 0).toLocaleString()} />
        <StatCard label="Comprehensive (4)" value={(globalByScore[4] ?? 0).toLocaleString()} />
      </div>

      {/* Score distribution legend */}
      <div className="flex flex-wrap gap-4 mb-6">
        {[1, 2, 3, 4].map((score) => (
          <div key={score} className="flex items-center gap-1.5">
            <div className={`h-3 w-3 rounded-sm ${SCORE_COLORS[score]}`} />
            <span className="text-xs text-muted-foreground">
              {score} - {SCORE_LABELS[score]} ({(globalByScore[score] ?? 0).toLocaleString()})
            </span>
          </div>
        ))}
      </div>

      {/* Coverage by entity type */}
      {typeStats.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">Coverage by Entity Type</h2>
          <div className="space-y-3">
            {typeStats.map((ts) => (
              <div key={ts.entityType}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium">{ts.entityType}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {ts.total} entities, avg {ts.avgScore.toFixed(2)}
                  </span>
                </div>
                <CoverageBar stats={ts} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Enrichment queue */}
      {rows.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-1">Enrichment Queue</h2>
          <p className="text-sm text-muted-foreground mb-3">
            Entities ranked by lowest coverage score. Use this to prioritize data
            enrichment work.
          </p>
          <CoverageTable data={rows} entityTypes={entityTypes} />
        </div>
      )}

      {totalEntities === 0 && (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground my-6">
          <p className="text-lg font-medium mb-2">No coverage scans yet</p>
          <p className="text-sm">
            Run{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
              pnpm crux wiki-server sync-coverage-scans
            </code>{" "}
            to compute and sync coverage scores.
          </p>
        </div>
      )}
    </>
  );
}

// ── Helper Components ────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}
