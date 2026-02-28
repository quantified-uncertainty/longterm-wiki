import { fetchDetailed, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { GroundskeeperRunsTable } from "./groundskeeper-runs-table";
import type {
  GroundskeeperRunRow as CanonicalRow,
  GroundskeeperStatsResult,
} from "@wiki-server/api-response-types";

// ── Types ─────────────────────────────────────────────────────────────────

export interface GroundskeeperRunRow {
  id: number;
  taskName: string;
  event: string;
  success: boolean;
  durationMs: number | null;
  summary: string | null;
  errorMessage: string | null;
  consecutiveFailures: number | null;
  circuitBreakerActive: boolean;
  timestamp: string;
}

interface TaskStat {
  taskName: string;
  last24h: {
    total: number;
    success: number;
    failure: number;
    avgDurationMs: number | null;
    lastRun: string | null;
    lastSuccess: string | null;
    successRate: number | null;
  };
  allTime: {
    total: number;
    firstRun: string | null;
  };
}

// ── Data Loading ──────────────────────────────────────────────────────────

interface ApiData {
  runs: GroundskeeperRunRow[];
  stats: TaskStat[];
}

async function loadFromApi(): Promise<FetchResult<ApiData>> {
  // Fetch runs + stats in parallel
  const [runsResult, statsResult] = await Promise.all([
    fetchDetailed<{ runs: CanonicalRow[]; total: number }>(
      "/api/groundskeeper-runs?limit=200",
      { revalidate: 30 }
    ),
    fetchDetailed<GroundskeeperStatsResult>(
      "/api/groundskeeper-runs/stats",
      { revalidate: 30 }
    ),
  ]);

  if (!runsResult.ok) return runsResult;

  const runs: GroundskeeperRunRow[] = runsResult.data.runs.map(
    (r): GroundskeeperRunRow => ({
      id: r.id,
      taskName: r.taskName,
      event: r.event,
      success: r.success,
      durationMs: r.durationMs,
      summary: r.summary,
      errorMessage: r.errorMessage,
      consecutiveFailures: r.consecutiveFailures,
      circuitBreakerActive: r.circuitBreakerActive,
      timestamp: r.timestamp,
    })
  );

  const stats: TaskStat[] = statsResult.ok ? statsResult.data.stats : [];

  return { ok: true, data: { runs, stats } };
}

function noLocalFallback(): ApiData {
  return { runs: [], stats: [] };
}

// ── Summary Cards ─────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  subtext,
  colorClass,
}: {
  label: string;
  value: string | number;
  subtext?: string;
  colorClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${colorClass ?? ""}`}>
        {value}
      </p>
      {subtext && (
        <p className="text-xs text-muted-foreground mt-0.5">{subtext}</p>
      )}
    </div>
  );
}

function TaskStatsRow({ stat }: { stat: TaskStat }) {
  const { last24h, allTime } = stat;
  const successRate = last24h.successRate ?? 0;
  const rateColor =
    successRate >= 95
      ? "text-green-600"
      : successRate >= 80
        ? "text-yellow-600"
        : "text-red-500";

  return (
    <div className="rounded-lg border border-border/60 p-4 flex items-center gap-6">
      <div className="min-w-[120px]">
        <p className="font-medium text-sm">{stat.taskName}</p>
        <p className="text-xs text-muted-foreground">
          {allTime.total} all-time runs
        </p>
      </div>
      <div className="flex-1 grid grid-cols-4 gap-4 text-center">
        <div>
          <p className="text-xs text-muted-foreground">24h runs</p>
          <p className="text-sm font-semibold tabular-nums">
            {last24h.total}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Success rate</p>
          <p className={`text-sm font-semibold tabular-nums ${rateColor}`}>
            {successRate}%
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Avg duration</p>
          <p className="text-sm font-semibold tabular-nums">
            {last24h.avgDurationMs
              ? `${(last24h.avgDurationMs / 1000).toFixed(1)}s`
              : "—"}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Last run</p>
          <p className="text-xs tabular-nums text-muted-foreground">
            {last24h.lastRun
              ? new Date(last24h.lastRun).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "—"}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Content Component ────────────────────────────────────────────────────

export async function GroundskeeperRunsContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback
  );

  const { runs, stats } = data;
  const totalRuns = runs.length;
  const successCount = runs.filter((r) => r.success).length;
  const failureCount = totalRuns - successCount;
  const circuitBreakerActive = runs.some((r) => r.circuitBreakerActive);

  return (
    <>
      <p className="text-muted-foreground">
        Task execution history from the groundskeeper daemon. Shows scheduled
        task runs, success rates, durations, and circuit breaker status.
      </p>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 my-4">
        <StatCard label="Total runs" value={totalRuns} subtext="last 200" />
        <StatCard
          label="Successes"
          value={successCount}
          colorClass="text-green-600"
        />
        <StatCard
          label="Failures"
          value={failureCount}
          colorClass={failureCount > 0 ? "text-red-500" : undefined}
        />
        <StatCard
          label="Circuit breaker"
          value={circuitBreakerActive ? "TRIPPED" : "OK"}
          colorClass={circuitBreakerActive ? "text-red-500" : "text-green-600"}
        />
      </div>

      {/* Per-task stats (last 24h) */}
      {stats.length > 0 && (
        <div className="space-y-2 my-6">
          <h3 className="text-sm font-semibold text-muted-foreground mb-2">
            Task stats (last 24h)
          </h3>
          {stats.map((s) => (
            <TaskStatsRow key={s.taskName} stat={s} />
          ))}
        </div>
      )}

      {/* Runs table */}
      {runs.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No runs recorded</p>
          <p className="text-sm">
            Runs will appear here once the groundskeeper daemon starts executing
            scheduled tasks.
          </p>
        </div>
      ) : (
        <GroundskeeperRunsTable data={runs} />
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}
