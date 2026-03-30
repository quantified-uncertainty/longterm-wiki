import {
  fetchDetailed,
  withApiFallback,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { JobsOverviewTable } from "./jobs-overview-table";
import { RecentFailuresTable } from "./jobs-failures-table";

// ── Types ────────────────────────────────────────────────────────────────

interface JobStatsResponse {
  totalJobs: number;
  byType: Record<
    string,
    {
      byStatus: Record<string, number>;
      avgDurationMs?: number;
      failureRate?: number;
    }
  >;
}

interface JobEntry {
  id: number;
  type: string;
  status: string;
  params: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  priority: number;
  retries: number;
  maxRetries: number;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  workerId: string | null;
  runAfter: string | null;
  dedupKey: string | null;
  parentJobId: number | null;
  costUsd: string | null;
}

interface JobListResponse {
  entries: JobEntry[];
  total: number;
  limit: number;
  offset: number;
}

// Exported for tables
export interface TypeRow {
  type: string;
  pending: number;
  claimed: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
  avgDurationMs: number | null;
  failureRate: number | null;
}

export interface FailureRow {
  id: number;
  type: string;
  error: string;
  retries: number;
  maxRetries: number;
  createdAt: string;
  completedAt: string | null;
  workerId: string | null;
}

// ── Data Loading ─────────────────────────────────────────────────────────

interface DashboardData {
  stats: JobStatsResponse;
  recentFailures: JobEntry[];
}

async function loadFromApi() {
  const [statsResult, failuresResult] = await Promise.all([
    fetchDetailed<JobStatsResponse>("/api/jobs/stats", { revalidate: 30 }),
    fetchDetailed<JobListResponse>("/api/jobs?status=failed&limit=50", {
      revalidate: 30,
    }),
  ]);

  if (!statsResult.ok) return statsResult;
  if (!failuresResult.ok) return failuresResult;

  return {
    ok: true as const,
    data: {
      stats: statsResult.data,
      recentFailures: failuresResult.data.entries,
    },
  };
}

function emptyData(): DashboardData {
  return {
    stats: { totalJobs: 0, byType: {} },
    recentFailures: [],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

const STATUSES = [
  "pending",
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

function buildTypeRows(stats: JobStatsResponse): TypeRow[] {
  return Object.entries(stats.byType)
    .map(([type, info]) => {
      const row: TypeRow = {
        type,
        pending: info.byStatus["pending"] ?? 0,
        claimed: info.byStatus["claimed"] ?? 0,
        running: info.byStatus["running"] ?? 0,
        completed: info.byStatus["completed"] ?? 0,
        failed: info.byStatus["failed"] ?? 0,
        cancelled: info.byStatus["cancelled"] ?? 0,
        total: 0,
        avgDurationMs: info.avgDurationMs ?? null,
        failureRate: info.failureRate ?? null,
      };
      row.total = STATUSES.reduce(
        (sum, s) => sum + (info.byStatus[s] ?? 0),
        0
      );
      return row;
    })
    .sort((a, b) => b.total - a.total);
}

function buildFailureRows(entries: JobEntry[]): FailureRow[] {
  return entries.map((j) => ({
    id: j.id,
    type: j.type,
    error: j.error ?? "Unknown error",
    retries: j.retries,
    maxRetries: j.maxRetries,
    createdAt: j.createdAt,
    completedAt: j.completedAt,
    workerId: j.workerId,
  }));
}

// ── Status summary helpers ───────────────────────────────────────────────

function StatusPill({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  if (count === 0) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${color}`}
    >
      {count} {label}
    </span>
  );
}

function AggregateSummary({ typeRows }: { typeRows: TypeRow[] }) {
  const totals = typeRows.reduce(
    (acc, r) => ({
      pending: acc.pending + r.pending,
      claimed: acc.claimed + r.claimed,
      running: acc.running + r.running,
      completed: acc.completed + r.completed,
      failed: acc.failed + r.failed,
      cancelled: acc.cancelled + r.cancelled,
    }),
    { pending: 0, claimed: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
  );

  return (
    <div className="flex flex-wrap gap-2">
      <StatusPill
        label="pending"
        count={totals.pending}
        color="bg-yellow-500/15 text-yellow-600"
      />
      <StatusPill
        label="claimed"
        count={totals.claimed}
        color="bg-blue-500/15 text-blue-600"
      />
      <StatusPill
        label="running"
        count={totals.running}
        color="bg-indigo-500/15 text-indigo-600"
      />
      <StatusPill
        label="completed"
        count={totals.completed}
        color="bg-emerald-500/15 text-emerald-600"
      />
      <StatusPill
        label="failed"
        count={totals.failed}
        color="bg-red-500/15 text-red-600"
      />
      <StatusPill
        label="cancelled"
        count={totals.cancelled}
        color="bg-muted text-muted-foreground"
      />
    </div>
  );
}

// ── Content Component ────────────────────────────────────────────────────

export async function JobsDashboardContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    emptyData
  );

  const typeRows = buildTypeRows(data.stats);
  const failureRows = buildFailureRows(data.recentFailures);
  const totalJobs = data.stats.totalJobs;

  return (
    <>
      <p className="text-muted-foreground">
        Background job queue monitoring.{" "}
        {totalJobs > 0 ? (
          <>
            <span className="font-medium text-foreground">{totalJobs}</span>{" "}
            total jobs across{" "}
            <span className="font-medium text-foreground">
              {typeRows.length}
            </span>{" "}
            types.
          </>
        ) : (
          "No jobs found."
        )}
      </p>

      {totalJobs > 0 && <AggregateSummary typeRows={typeRows} />}

      {typeRows.length > 0 && (
        <>
          <h2>Jobs by Type</h2>
          <JobsOverviewTable data={typeRows} />
        </>
      )}

      {failureRows.length > 0 && (
        <>
          <h2>Recent Failures</h2>
          <RecentFailuresTable data={failureRows} />
        </>
      )}

      {totalJobs === 0 && (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No jobs found</p>
          <p className="text-sm">
            The job queue is empty. Jobs are created by background workers
            (claim verification, resource verification, page improve, auto-update).
          </p>
        </div>
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}
