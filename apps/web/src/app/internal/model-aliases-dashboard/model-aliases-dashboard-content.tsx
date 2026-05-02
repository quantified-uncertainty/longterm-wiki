/**
 * Model Aliases Dashboard — exposes the model_aliases table that maps raw
 * external model names (e.g. "gpt-4-turbo-2024-04-09") to canonical AI-model
 * entity stable_ids. Used by Phase 2 benchmark ingesters at resolution time.
 *
 * QUA-745 — surfaces existing data; no new ingest path.
 */
import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
  type RpcModelAliasesAllResult,
  type RpcModelAliasesStatsResult,
  type RpcModelAliasRow,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";

// ── Types ────────────────────────────────────────────────────────────────

interface DashboardData {
  stats: RpcModelAliasesStatsResult;
  aliases: RpcModelAliasRow[];
}

// ── Data Loading ─────────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const [statsResult, allResult] = await Promise.all([
    fetchDetailed<RpcModelAliasesStatsResult>("/api/model-aliases/stats", {
      revalidate: 60,
    }),
    fetchDetailed<RpcModelAliasesAllResult>(
      "/api/model-aliases/all?limit=500",
      { revalidate: 60 },
    ),
  ]);

  if (!statsResult.ok) return statsResult;
  if (!allResult.ok) return allResult;

  return {
    ok: true,
    data: { stats: statsResult.data, aliases: allResult.data.items },
  };
}

function emptyFallback(): DashboardData {
  return {
    stats: { total: 0, bySource: [], byConfidence: [] },
    aliases: [],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function confidenceColor(c: string): string {
  switch (c) {
    case "exact":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
    case "fuzzy":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
    case "manual":
      return "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300";
    default:
      return "bg-muted/40 text-muted-foreground";
  }
}

// ── Content Component ────────────────────────────────────────────────────

export async function ModelAliasesDashboardContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    emptyFallback,
  );

  const { stats, aliases } = data;

  // Group aliases by their target model (modelStableId) — the dashboard's
  // primary view is "for each canonical model, what aliases point at it?".
  const byModel = new Map<string, RpcModelAliasRow[]>();
  for (const a of aliases) {
    const arr = byModel.get(a.modelStableId);
    if (arr) arr.push(a);
    else byModel.set(a.modelStableId, [a]);
  }
  const groupedRows = Array.from(byModel.entries())
    .map(([modelStableId, rows]) => ({
      modelStableId,
      rows: rows.sort((a, b) => a.alias.localeCompare(b.alias)),
    }))
    .sort((a, b) => b.rows.length - a.rows.length);

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Maps raw external model names (e.g.{" "}
        <code className="text-xs">gpt-4-turbo-2024-04-09</code>) to the
        canonical AI-model entity (e.g. <code className="text-xs">GPT-4 Turbo</code>).
        Populated by{" "}
        <code className="text-xs">crux tb model-aliases sync</code> from
        seed YAML and ingester promotions out of benchmark quarantine. Backed
        by the <code className="text-xs">model_aliases</code> table.
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 my-6">
        <StatCard label="Total Aliases" value={stats.total.toString()} />
        <StatCard
          label="Canonical Models"
          value={byModel.size.toString()}
          sub={`with ≥1 alias`}
        />
        <StatCard
          label="Sources"
          value={stats.bySource.length.toString()}
          sub={
            stats.bySource.length > 0
              ? stats.bySource
                  .map((s) => `${s.source} (${s.total})`)
                  .join(", ")
              : undefined
          }
        />
        <StatCard
          label="By Confidence"
          value={stats.byConfidence.reduce((s, x) => s + x.total, 0).toString()}
          sub={
            stats.byConfidence.length > 0
              ? stats.byConfidence
                  .map((c) => `${c.confidence} (${c.total})`)
                  .join(", ")
              : undefined
          }
        />
      </div>

      {/* Grouped table — one row per (model, alias) — model rowspans across its aliases */}
      {groupedRows.length > 0 && (
        <div className="my-6 rounded-lg border border-border/60 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr className="text-xs text-muted-foreground">
                <th className="py-2 px-3 text-left font-medium">Canonical Model</th>
                <th className="py-2 px-3 text-left font-medium">Alias</th>
                <th className="py-2 px-3 text-left font-medium">Source</th>
                <th className="py-2 px-3 text-left font-medium">Confidence</th>
                <th className="py-2 px-3 text-left font-medium">Synced</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {groupedRows.flatMap((g) =>
                g.rows.map((row, i) => (
                  <tr
                    key={`${g.modelStableId}-${row.alias}`}
                    className="hover:bg-muted/20"
                  >
                    {i === 0 ? (
                      <td
                        rowSpan={g.rows.length}
                        className="py-2 px-3 align-top font-mono text-xs text-muted-foreground border-r border-border/50"
                      >
                        {g.modelStableId}
                        <span className="block text-muted-foreground/50">
                          {g.rows.length} alias{g.rows.length === 1 ? "" : "es"}
                        </span>
                      </td>
                    ) : null}
                    <td className="py-2 px-3 font-mono text-xs">{row.alias}</td>
                    <td className="py-2 px-3 text-muted-foreground">
                      {row.source}
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${confidenceColor(
                          row.confidence,
                        )}`}
                      >
                        {row.confidence}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-xs text-muted-foreground tabular-nums">
                      {row.syncedAt
                        ? new Date(row.syncedAt).toISOString().slice(0, 10)
                        : "—"}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          {stats.total > aliases.length && (
            <div className="px-3 py-2 text-xs text-muted-foreground text-center bg-muted/20">
              Showing {aliases.length} of {stats.total} aliases
            </div>
          )}
        </div>
      )}

      {stats.total === 0 && (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground my-6">
          <p className="text-lg font-medium mb-2">No model aliases yet</p>
          <p className="text-sm">
            Run{" "}
            <code className="text-xs">
              crux tb model-aliases sync
            </code>{" "}
            to populate this table from seed YAML, or promote an entry from{" "}
            <a
              href="/wiki/E2541"
              className="text-primary hover:underline"
            >
              Benchmark Quarantine
            </a>
            .
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
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}
