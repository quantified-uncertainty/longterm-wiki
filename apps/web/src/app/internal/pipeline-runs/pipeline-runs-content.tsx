import { fetchDetailed, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { PipelineRunsTable } from "./pipeline-runs-table";
import type {
  PipelineRunRow,
  PipelineRunsStatsResult,
} from "@wiki-server/api-response-types";

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * Display row — flattened from the API row, with a precomputed
 * `durationMs` so the table sorts and renders without reaching back
 * into the timestamps.
 */
export interface PipelineRunDisplayRow {
  runId: string;
  pipelineName: string;
  shape: string | null;
  entityId: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  failureReason: string | null;
  errorCode: string | null;
}

interface ApiData {
  runs: PipelineRunDisplayRow[];
  stats: PipelineRunsStatsResult | null;
}

// ── Data Loading ──────────────────────────────────────────────────────────

function toDisplayRow(r: PipelineRunRow): PipelineRunDisplayRow {
  // Drizzle returns Date | string depending on serialization; force string.
  const startedAt =
    typeof r.startedAt === "string" ? r.startedAt : new Date(r.startedAt).toISOString();
  const endedAt =
    r.endedAt == null
      ? null
      : typeof r.endedAt === "string"
        ? r.endedAt
        : new Date(r.endedAt).toISOString();
  const durationMs =
    endedAt != null
      ? new Date(endedAt).getTime() - new Date(startedAt).getTime()
      : null;
  return {
    runId: r.runId,
    pipelineName: r.pipelineName,
    shape: r.shape,
    entityId: r.entityId,
    status: r.status,
    startedAt,
    endedAt,
    durationMs,
    failureReason: r.failureReason,
    errorCode: r.errorCode,
  };
}

async function loadFromApi(): Promise<FetchResult<ApiData>> {
  const [runsResult, statsResult] = await Promise.all([
    fetchDetailed<{ runs: PipelineRunRow[]; total: number }>(
      "/api/pipeline-runs?limit=200",
      { revalidate: 30 }
    ),
    fetchDetailed<PipelineRunsStatsResult>("/api/pipeline-runs/stats", {
      revalidate: 30,
    }),
  ]);

  if (!runsResult.ok) return runsResult;

  const runs: PipelineRunDisplayRow[] = runsResult.data.runs.map(toDisplayRow);
  const stats: PipelineRunsStatsResult | null = statsResult.ok
    ? statsResult.data
    : null;

  return { ok: true, data: { runs, stats } };
}

function noLocalFallback(): ApiData {
  return { runs: [], stats: null };
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

function statusCount(
  byStatus: PipelineRunsStatsResult["byStatus"],
  status: string,
): number {
  return byStatus.find((s) => s.status === status)?.count ?? 0;
}

// ── Content Component ────────────────────────────────────────────────────

export async function PipelineRunsContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    noLocalFallback
  );

  const { runs, stats } = data;
  const totalRuns = runs.length;
  const last24h = stats?.byStatus ?? [];
  const running = statusCount(last24h, "running");
  const committed = statusCount(last24h, "committed");
  const aborted = statusCount(last24h, "aborted");
  const oscillation = statusCount(last24h, "oscillation");
  const partialFailure = statusCount(last24h, "partial_failure");
  const failureReasons = stats?.byFailureReason ?? [];

  return (
    <>
      <p className="text-muted-foreground">
        Per-run lifecycle history for generation / improve / sourcing pipelines.
        Each row is one execution wrapped by{" "}
        <code className="text-xs">withPipelineRun()</code>. Use this to see
        what's running now, what aborted recently, and which failure
        reasons are recurring.
      </p>

      {/* Summary cards (last 24h) */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 my-4">
        <StatCard
          label="Running"
          value={running}
          subtext="last 24h"
          colorClass={running > 0 ? "text-blue-600" : undefined}
        />
        <StatCard
          label="Committed"
          value={committed}
          subtext="last 24h"
          colorClass={committed > 0 ? "text-green-600" : undefined}
        />
        <StatCard
          label="Aborted"
          value={aborted}
          subtext="last 24h"
          colorClass={aborted > 0 ? "text-red-500" : undefined}
        />
        <StatCard
          label="Oscillation"
          value={oscillation}
          subtext="last 24h"
          colorClass={oscillation > 0 ? "text-orange-600" : undefined}
        />
        <StatCard
          label="Partial failure"
          value={partialFailure}
          subtext="last 24h"
          colorClass={partialFailure > 0 ? "text-yellow-600" : undefined}
        />
      </div>

      {/* Failure-reason breakdown */}
      {failureReasons.length > 0 && (
        <div className="my-6">
          <h3 className="text-sm font-semibold text-muted-foreground mb-2">
            Failure reasons (last 24h)
          </h3>
          <div className="rounded-lg border border-border/60 divide-y divide-border/60">
            {failureReasons
              .slice()
              .sort((a, b) => b.count - a.count)
              .map((row) => (
                <div
                  key={row.failureReason ?? "<null>"}
                  className="flex items-center justify-between p-3"
                >
                  <span className="text-sm">{row.failureReason ?? "—"}</span>
                  <span className="text-sm font-semibold tabular-nums">
                    {row.count}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Runs table */}
      {totalRuns === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No pipeline runs recorded</p>
          <p className="text-sm">
            Runs will appear once a pipeline wraps its execution with{" "}
            <code className="text-xs">withPipelineRun()</code>.
          </p>
        </div>
      ) : (
        <PipelineRunsTable data={runs} />
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}
