// Triage queue for benchmark_results_pending (QUA-689 Phase 2 / QUA-742).
// Resolution path: crux tb model-aliases sync → next ingester run promotes
// the row from this queue into benchmark_results.

import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
  type RpcBenchmarkResultsPendingAllResult,
  type RpcBenchmarkResultsPendingStatsResult,
  type RpcBenchmarkResultsPendingRow,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { StatCard } from "@/app/data-sources/data-sources-shared";
import { getBenchmarkEntities } from "@/app/benchmarks/benchmark-utils";
import {
  BenchmarkQuarantineTable,
  type BenchmarkQuarantineRow,
} from "./benchmark-quarantine-table";

interface DashboardData {
  stats: RpcBenchmarkResultsPendingStatsResult;
  rows: RpcBenchmarkResultsPendingRow[];
}

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

// Benchmark entities are build-time data — cache the id/stableId lookup map
// so we don't rebuild it on every server render.
let benchmarkLookupCache: Map<string, { name: string; slug: string }> | null = null;

function getBenchmarkLookup(): Map<string, { name: string; slug: string }> {
  if (benchmarkLookupCache) return benchmarkLookupCache;
  const map = new Map<string, { name: string; slug: string }>();
  for (const b of getBenchmarkEntities()) {
    map.set(b.id, { name: b.title, slug: b.id });
    if (b.stableId) map.set(b.stableId, { name: b.title, slug: b.id });
  }
  benchmarkLookupCache = map;
  return map;
}

function enrichRows(
  rows: RpcBenchmarkResultsPendingRow[],
): BenchmarkQuarantineRow[] {
  const lookup = getBenchmarkLookup();
  return rows.map((r) => {
    const benchmark = lookup.get(r.benchmarkId);
    return {
      ...r,
      benchmarkName: benchmark?.name ?? r.benchmarkId,
      benchmarkSlug: benchmark?.slug ?? null,
    };
  });
}

export async function BenchmarkQuarantineContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    emptyFallback,
  );
  const { stats, rows } = data;
  const enriched = enrichRows(rows);

  const serverStatusCounts = { pending: 0, resolved: 0, rejected: 0 };
  for (const s of stats.byStatus) {
    if (s.status in serverStatusCounts) {
      serverStatusCounts[s.status as keyof typeof serverStatusCounts] = s.total;
    }
  }

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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 my-6">
        <StatCard label="Pending" value={serverStatusCounts.pending} color="text-amber-600" />
        <StatCard label="Resolved" value={serverStatusCounts.resolved} color="text-emerald-600" />
        <StatCard label="Rejected" value={serverStatusCounts.rejected} color="text-muted-foreground" />
        <StatCard label="Total" value={stats.total} />
      </div>

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

      {/* Empty state branches on server-side total so 0 rows of any status
          shows "Queue is clear", and a queue with only non-pending rows still
          shows the table (the table's initial filter handles that case). */}
      {stats.total > 0 ? (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">Quarantine rows</h2>
          <BenchmarkQuarantineTable
            data={enriched}
            serverStatusCounts={serverStatusCounts}
            totalRowCount={stats.total}
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
