/**
 * Benchmark Quarantine Dashboard — triage queue for `benchmark_results_pending`
 * (QUA-689 Phase 2 / QUA-742).
 *
 * Surfaces:
 *   1. Pending row count + breakdown by status (pending / resolved / rejected)
 *   2. Per-source breakdown (which ingester is producing the most unresolved rows)
 *   3. Row table — model/benchmark/score/source URL/ingested-at + filters
 *
 * Resolution today is via the crux CLI (`crux tb model-aliases sync` +
 * `crux tb benchmark-results sync`); the table surfaces source URL and a
 * link to the entity-profile viewer for the parent benchmark so reviewers
 * can identify the right canonical model entity.
 */

import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
  type RpcBenchmarkResultsPendingAllResult,
  type RpcBenchmarkResultsPendingStatsResult,
  type RpcBenchmarkResultsPendingRow,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { getBenchmarkEntities } from "@/app/benchmarks/benchmark-utils";
import {
  BenchmarkQuarantineTable,
  type BenchmarkQuarantineRow,
} from "./benchmark-quarantine-table";

// ── Types ─────────────────────────────────────────────────────────────────

interface DashboardData {
  stats: RpcBenchmarkResultsPendingStatsResult;
  rows: RpcBenchmarkResultsPendingRow[];
}

// ── Data Loading ──────────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const [statsResult, allResult] = await Promise.all([
    fetchDetailed<RpcBenchmarkResultsPendingStatsResult>(
      "/api/benchmark-results-pending/stats",
      { revalidate: 60 },
    ),
    fetchDetailed<RpcBenchmarkResultsPendingAllResult>(
      "/api/benchmark-results-pending/all?limit=500",
      { revalidate: 60 },
    ),
  ]);

  if (!statsResult.ok) return statsResult;
  if (!allResult.ok) return allResult;

  return {
    ok: true,
    data: { stats: statsResult.data, rows: allResult.data.items },
  };
}

function emptyFallback(): DashboardData {
  return {
    stats: { total: 0, byStatus: [], bySource: [] },
    rows: [],
  };
}

// ── Benchmark name resolution ────────────────────────────────────────────

function buildBenchmarkLookup(): Map<string, { name: string; slug: string }> {
  const map = new Map<string, { name: string; slug: string }>();
  for (const b of getBenchmarkEntities()) {
    map.set(b.id, { name: b.title, slug: b.id });
    if (b.stableId) map.set(b.stableId, { name: b.title, slug: b.id });
  }
  return map;
}

function enrichRows(
  rows: RpcBenchmarkResultsPendingRow[],
): BenchmarkQuarantineRow[] {
  const lookup = buildBenchmarkLookup();
  return rows.map((r) => {
    const benchmark = lookup.get(r.benchmarkId);
    return {
      ...r,
      benchmarkName: benchmark?.name ?? r.benchmarkId,
      benchmarkSlug: benchmark?.slug ?? null,
    };
  });
}

// ── Content Component ────────────────────────────────────────────────────

export async function BenchmarkQuarantineContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    emptyFallback,
  );
  const { stats, rows } = data;
  const enriched = enrichRows(rows);

  const statusCounts = new Map<string, number>();
  for (const s of stats.byStatus) statusCounts.set(s.status, s.total);
  const pendingCount = statusCounts.get("pending") ?? 0;
  const resolvedCount = statusCounts.get("resolved") ?? 0;
  const rejectedCount = statusCounts.get("rejected") ?? 0;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Triage queue for safety-benchmark ingester rows whose raw model name
        could not be resolved to a known entity. Promote rows by adding an
        alias via{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">
          crux tb model-aliases sync
        </code>{" "}
        (which will then auto-resolve and let the next ingester run promote
        the row to{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">
          benchmark_results
        </code>
        ); reject obvious noise by setting{" "}
        <code className="text-xs bg-muted px-1 py-0.5 rounded">status</code> =
        rejected with a reason.
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 my-6">
        <StatCard label="Pending" value={pendingCount.toString()} tone="warn" />
        <StatCard label="Resolved" value={resolvedCount.toString()} tone="ok" />
        <StatCard
          label="Rejected"
          value={rejectedCount.toString()}
          tone="muted"
        />
        <StatCard label="Total" value={stats.total.toString()} />
      </div>

      {/* Per-source breakdown */}
      {stats.bySource.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">By Ingester Source</h2>
          <div className="flex gap-2 flex-wrap">
            {stats.bySource
              .slice()
              .sort((a, b) => b.total - a.total)
              .map(({ ingesterSource, total }) => (
                <div
                  key={ingesterSource}
                  className="rounded-lg border border-border/60 px-3 py-2 flex items-center gap-2"
                >
                  <span className="text-xs font-mono text-foreground">
                    {ingesterSource}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {total}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Row table — empty state branches on the server-side total so 0 rows of
          any status renders the "queue is clear" copy, and rows-of-only-resolved/
          rejected still show the table (with the default filter set to "all"). */}
      {stats.total > 0 ? (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">Quarantine rows</h2>
          <BenchmarkQuarantineTable
            data={enriched}
            statusCounts={{
              pending: pendingCount,
              resolved: resolvedCount,
              rejected: rejectedCount,
            }}
            totalRowCount={stats.total}
            loadedRowCount={enriched.length}
          />
        </div>
      ) : (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground my-6">
          <p className="text-lg font-medium mb-2">Queue is clear</p>
          <p className="text-sm">
            No benchmark ingester rows are waiting for triage. New rows will
            appear here when an ingester encounters a raw model name that
            doesn't match any{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              model_aliases
            </code>{" "}
            entry.
          </p>
        </div>
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}

// ── Helper Components ────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "muted";
}) {
  const valueColor =
    tone === "warn"
      ? "text-amber-600"
      : tone === "ok"
        ? "text-emerald-600"
        : tone === "muted"
          ? "text-muted-foreground"
          : "text-foreground";
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${valueColor}`}>{value}</p>
    </div>
  );
}
