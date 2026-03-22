import {
  fetchDetailed,
  withApiFallback,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { getTypedEntities } from "@data/tablebase";

// ── Types ─────────────────────────────────────────────────────────────────

/** Stats shape returned by GET /api/source-checks/stats (unified) */
interface UnifiedSourceCheckStatsResult {
  total: number;
  avg_confidence: number;
  needs_recheck: number;
  by_verdict: Record<string, number>;
  by_type: Record<string, number>;
}

// ── Verdict colors ────────────────────────────────────────────────────────

const VERDICT_COLORS: Record<string, string> = {
  confirmed: "text-emerald-600",
  contradicted: "text-red-600",
  outdated: "text-amber-600",
  partial: "text-amber-500",
  unverifiable: "text-muted-foreground",
  unchecked: "text-muted-foreground",
};

const BAR_COLORS: Record<string, string> = {
  confirmed: "bg-emerald-500",
  contradicted: "bg-red-500",
  outdated: "bg-amber-500",
  partial: "bg-amber-400",
  unverifiable: "bg-gray-400",
  unchecked: "bg-gray-300",
};

// ── Data loading ──────────────────────────────────────────────────────────

function emptySourceCheckStats(): UnifiedSourceCheckStatsResult {
  return {
    total: 0,
    avg_confidence: 0,
    needs_recheck: 0,
    by_verdict: {},
    by_type: {},
  };
}

async function loadSourceCheckStats() {
  return fetchDetailed<UnifiedSourceCheckStatsResult>("/api/verifications/stats", {
    revalidate: 60,
  });
}

// ── Stat Card ─────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p
        className={`text-2xl font-bold tabular-nums ${color || ""}`}
      >
        {value}
      </p>
      {sub && (
        <p className="text-xs text-muted-foreground mt-1">{sub}</p>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

export async function SourceCheckCoverageContent() {
  const verificationResult = await withApiFallback(
    loadSourceCheckStats,
    emptySourceCheckStats
  );

  const vStats: UnifiedSourceCheckStatsResult = {
    ...emptySourceCheckStats(),
    ...verificationResult.data,
  };

  const source = verificationResult.source === "api" ? "api" as const : "local" as const;
  const apiError = verificationResult.apiError;

  // Local entity data for entity type counts
  const entities = getTypedEntities();
  const entityCountByType = new Map<string, number>();
  for (const e of entities) {
    const t = e.entityType;
    entityCountByType.set(t, (entityCountByType.get(t) ?? 0) + 1);
  }
  const totalEntities = entities.length;
  const entityTypes = [...entityCountByType.keys()].sort();

  // Verdict distribution from unified source-check system
  const verdictEntries = Object.entries(vStats.by_verdict ?? {}).sort(
    ([, a], [, b]) => b - a
  );
  const totalVerdicts = verdictEntries.reduce((s, [, c]) => s + c, 0);

  return (
    <>
      <DataSourceBanner source={source} apiError={apiError} />

      <p className="text-muted-foreground text-sm leading-relaxed mb-6">
        Source-check coverage across all record types. Data from the unified{" "}
        <code className="text-[11px]">source_check_verdicts</code> and{" "}
        <code className="text-[11px]">source_check_evidence</code> tables.
      </p>

      {/* ── (a) Summary cards ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 not-prose mb-8">
        <StatCard
          label="Total Entities"
          value={totalEntities.toLocaleString()}
          sub={`${entityTypes.length} entity types`}
        />
        <StatCard
          label="Total Verdicts"
          value={vStats.total.toLocaleString()}
          sub={Object.entries(vStats.by_type ?? {}).map(([t, c]) => `${t}: ${c}`).join(", ") || "None yet"}
        />
        <StatCard
          label="Avg Confidence"
          value={
            vStats.avg_confidence > 0
              ? `${Math.round(vStats.avg_confidence * 100)}%`
              : "N/A"
          }
          sub={`Across ${vStats.total.toLocaleString()} verdicts`}
        />
        <StatCard
          label="Needs Recheck"
          value={vStats.needs_recheck.toLocaleString()}
          color={vStats.needs_recheck > 0 ? "text-amber-600" : ""}
          sub={vStats.needs_recheck > 0 ? "Verdicts flagged for recheck" : "All up to date"}
        />
      </div>

      {/* ── (b) Entities by Type ────────────────────────────────── */}
      <div className="not-prose mb-8">
        <h2 className="text-lg font-semibold mb-3">
          Entities by Type
        </h2>
        <p className="text-sm text-muted-foreground mb-3">
          Entity counts from local <code className="text-[11px]">database.json</code>.
          Verification verdicts are tracked by record type (personnel, division, etc.), not entity type.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border/60">
                <th className="text-left py-2 px-3 font-medium">
                  Entity Type
                </th>
                <th className="text-right py-2 px-3 font-medium">Count</th>
              </tr>
            </thead>
            <tbody>
              {[...entityCountByType.entries()]
                .sort(([, a], [, b]) => b - a)
                .map(([type, count]) => (
                  <tr
                    key={type}
                    className="border-b border-border/30 hover:bg-muted/30"
                  >
                    <td className="py-2 px-3 font-medium">{type}</td>
                    <td className="text-right py-2 px-3 tabular-nums">
                      {count}
                    </td>
                  </tr>
                ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border/60 font-semibold">
                <td className="py-2 px-3">Total</td>
                <td className="text-right py-2 px-3 tabular-nums">
                  {totalEntities}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* ── (c) Verdict Distribution ───────────────────────────────────── */}
      {verdictEntries.length > 0 && (
        <div className="not-prose mb-8">
          <h2 className="text-lg font-semibold mb-3">
            Verdict Distribution
          </h2>
          <p className="text-sm text-muted-foreground mb-3">
            All verdicts from the unified source-check system.
          </p>

          {/* Badges */}
          <div className="flex gap-2 flex-wrap mb-4">
            {verdictEntries.map(([verdict, count]) => (
              <span
                key={verdict}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-muted ${VERDICT_COLORS[verdict] || "text-muted-foreground"}`}
              >
                {verdict}
                <span className="tabular-nums font-semibold">{count}</span>
                <span className="text-muted-foreground">
                  (
                  {totalVerdicts > 0
                    ? Math.round((count / totalVerdicts) * 100)
                    : 0}
                  %)
                </span>
              </span>
            ))}
          </div>

          {/* Distribution bar */}
          {totalVerdicts > 0 && (
            <div className="mb-4">
              <div className="flex rounded-full overflow-hidden h-4">
                {verdictEntries.map(([verdict, count]) => (
                  <div
                    key={verdict}
                    className={BAR_COLORS[verdict] || "bg-gray-300"}
                    style={{
                      width: `${(count / totalVerdicts) * 100}%`,
                    }}
                    title={`${verdict}: ${count}`}
                  />
                ))}
              </div>
              <div className="flex justify-between text-xs text-muted-foreground mt-1 flex-wrap gap-x-4">
                {verdictEntries.map(([verdict, count]) => (
                  <span key={verdict}>
                    {verdict}:{" "}
                    {Math.round((count / totalVerdicts) * 100)}%
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Per-type summary */}
          {Object.keys(vStats.by_type ?? {}).length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
              {Object.entries(vStats.by_type).sort(([,a],[,b]) => b - a).map(([type, count]) => (
                <div key={type} className="rounded-lg border border-border/60 p-4">
                  <h3 className="text-sm font-semibold mb-1 capitalize">{type}</h3>
                  <p className="text-2xl font-bold tabular-nums">{count}</p>
                  <p className="text-xs text-muted-foreground mt-1">verdicts</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Data source footer ─────────────────────────────────────────── */}
      <p className="text-xs text-muted-foreground mt-4">
        Data from{" "}
        <code className="text-[11px]">source_check_verdicts</code> and{" "}
        <code className="text-[11px]">source_check_evidence</code> tables in the
        wiki-server database. Entity counts from local{" "}
        <code className="text-[11px]">database.json</code>.
      </p>
    </>
  );
}
