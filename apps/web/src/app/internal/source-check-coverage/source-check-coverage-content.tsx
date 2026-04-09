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
  needs_recheck: number;
  by_verdict: Record<string, number>;
  by_type: Record<string, number>;
}

/** Shape returned by GET /api/source-checks/coverage-matrix */
interface CoverageMatrixResult {
  tables: Array<{
    recordType: string;
    totalRecords: number;
    checkedRecords?: number;
    verdicts: {
      confirmed: number;
      partial: number;
      unverifiable: number;
      contradicted: number;
      outdated: number;
      unchecked: number;
    };
    coveragePercent: number;
    greenPercent: number;
  }>;
  totals: {
    totalRecords: number;
    totalVerdicts: number;
    confirmedPercent: number;
    coveragePercent: number;
  };
}

/** Shape returned by GET /api/source-checks/verdict-matrix */
interface VerdictMatrixResult {
  matrix: Record<string, Record<string, number>>;
  totals: Record<string, number>;
}

// ── Verdict colors ────────────────────────────────────────────────────────

const VERDICT_COLORS: Record<string, string> = {
  confirmed: "text-emerald-600",
  contradicted: "text-red-600",
  outdated: "text-amber-600",
  partial: "text-amber-500",
  unverifiable: "text-orange-600",
  unchecked: "text-muted-foreground",
};

const BAR_COLORS: Record<string, string> = {
  confirmed: "bg-emerald-500",
  contradicted: "bg-red-500",
  outdated: "bg-amber-500",
  partial: "bg-amber-400",
  unverifiable: "bg-orange-400",
  unchecked: "bg-gray-300",
};

// ── Data loading ──────────────────────────────────────────────────────────

function emptySourceCheckStats(): UnifiedSourceCheckStatsResult {
  return {
    total: 0,
    needs_recheck: 0,
    by_verdict: {},
    by_type: {},
  };
}

async function loadSourceCheckStats() {
  return fetchDetailed<UnifiedSourceCheckStatsResult>("/api/source-checks/stats", {
    revalidate: 60,
  });
}

function emptyCoverageMatrix(): CoverageMatrixResult {
  return {
    tables: [],
    totals: { totalRecords: 0, totalVerdicts: 0, confirmedPercent: 0, coveragePercent: 0 },
  };
}

async function loadCoverageMatrix() {
  return fetchDetailed<CoverageMatrixResult>("/api/source-checks/coverage-matrix", {
    revalidate: 60,
  });
}

function emptyVerdictMatrix(): VerdictMatrixResult {
  return { matrix: {}, totals: {} };
}

async function loadVerdictMatrix() {
  return fetchDetailed<VerdictMatrixResult>("/api/source-checks/verdict-matrix", {
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
  const [sourceCheckResult, coverageMatrixResult, verdictMatrixResult] = await Promise.all([
    withApiFallback(loadSourceCheckStats, emptySourceCheckStats),
    withApiFallback(loadCoverageMatrix, emptyCoverageMatrix),
    withApiFallback(loadVerdictMatrix, emptyVerdictMatrix),
  ]);

  const vStats: UnifiedSourceCheckStatsResult = {
    ...emptySourceCheckStats(),
    ...sourceCheckResult.data,
  };

  const coverageMatrix: CoverageMatrixResult = {
    ...emptyCoverageMatrix(),
    ...coverageMatrixResult.data,
  };

  const verdictMatrix: VerdictMatrixResult = {
    ...emptyVerdictMatrix(),
    ...verdictMatrixResult.data,
  };

  // Surface failures from any of the three endpoints in the banner
  const allResults = [sourceCheckResult, coverageMatrixResult, verdictMatrixResult];
  const source = allResults.every((r) => r.source === "api")
    ? ("api" as const)
    : ("local" as const);
  const apiError = allResults.find((r) => r.apiError)?.apiError;

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
        Data quality and coverage across all record types.
      </p>

      {/* ── (a) Summary cards ──────────────────────────────────────────── */}
      {(() => {
        const bv = vStats.by_verdict ?? {};
        const confirmed = bv["confirmed"] ?? 0;
        const contradicted = bv["contradicted"] ?? 0;
        const outdated = bv["outdated"] ?? 0;
        const partial = bv["partial"] ?? 0;
        const unverifiable = bv["unverifiable"] ?? 0;
        const unchecked = bv["unchecked"] ?? 0;
        const totalChecked = vStats.total - unchecked;
        const hasIssues = contradicted + outdated + partial;
        const accuracyDenom = confirmed + contradicted + outdated;
        const accuracyRate = accuracyDenom > 0 ? (confirmed / accuracyDenom) * 100 : 0;
        const pct = (n: number) =>
          totalChecked > 0 ? `${Math.round((n / totalChecked) * 100)}%` : "—";

        return (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 not-prose mb-8">
            <StatCard
              label="Verified Correct"
              value={confirmed.toLocaleString()}
              color="text-emerald-600"
              sub={`${pct(confirmed)} of checked verdicts`}
            />
            <StatCard
              label="Has Issues"
              value={hasIssues.toLocaleString()}
              color={hasIssues > 0 ? "text-amber-600" : ""}
              sub={`${pct(hasIssues)} of checked verdicts`}
            />
            <StatCard
              label="Unverifiable"
              value={unverifiable.toLocaleString()}
              color="text-muted-foreground"
              sub={`${pct(unverifiable)} of checked verdicts`}
            />
            <StatCard
              label="Contradicted"
              value={contradicted.toLocaleString()}
              color={contradicted > 0 ? "text-red-600" : ""}
              sub={contradicted > 0 ? "Action required — data may be wrong" : "None found"}
            />
            <StatCard
              label="Accuracy Rate"
              value={
                accuracyDenom > 0
                  ? `${Math.round(accuracyRate)}%`
                  : "N/A"
              }
              color={
                accuracyDenom === 0
                  ? ""
                  : accuracyRate >= 90
                    ? "text-emerald-600"
                    : accuracyRate >= 75
                      ? "text-amber-600"
                      : "text-red-600"
              }
              sub="Confirmed / (Confirmed + Wrong + Outdated)"
            />
            <StatCard
              label="Needs Recheck"
              value={vStats.needs_recheck.toLocaleString()}
              color={vStats.needs_recheck > 0 ? "text-amber-600" : ""}
              sub={vStats.needs_recheck > 0 ? "Verdicts flagged for recheck" : "All up to date"}
            />
          </div>
        );
      })()}

      {/* ── (b) Entities by Type ────────────────────────────────── */}
      <div className="not-prose mb-8">
        <h2 className="text-lg font-semibold mb-3">
          Entities by Type
        </h2>
        <p className="text-sm text-muted-foreground mb-3">
          Entity counts from local <code className="text-[11px]">database.json</code>.
          Source-check verdicts are tracked by record type (personnel, division, etc.), not entity type.
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

      {/* ── (d) Coverage Matrix ──────────────────────────────────────── */}
      {coverageMatrix.tables.length > 0 && (
        <div className="not-prose mb-8">
          <h2 className="text-lg font-semibold mb-3">
            Coverage Matrix
          </h2>
          <p className="text-sm text-muted-foreground mb-3">
            Per-record-type breakdown: total records in each table vs how many have been source-checked,
            and what percentage are confirmed green.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border/60">
                  <th className="text-left py-2 px-3 font-medium">Record Type</th>
                  <th className="text-right py-2 px-3 font-medium">Total Records</th>
                  <th className="text-right py-2 px-3 font-medium">Checked</th>
                  <th className="text-right py-2 px-3 font-medium">Unchecked</th>
                  <th className="text-right py-2 px-3 font-medium">Coverage %</th>
                  <th className="text-right py-2 px-3 font-medium">Green %</th>
                </tr>
              </thead>
              <tbody>
                {coverageMatrix.tables.map((t) => {
                  const checked =
                    t.verdicts.confirmed +
                    t.verdicts.partial +
                    t.verdicts.unverifiable +
                    t.verdicts.contradicted +
                    t.verdicts.outdated;
                  return (
                    <tr
                      key={t.recordType}
                      className="border-b border-border/30 hover:bg-muted/30"
                    >
                      <td className="py-2 px-3 font-medium">{t.recordType}</td>
                      <td className="text-right py-2 px-3 tabular-nums">
                        {t.totalRecords.toLocaleString()}
                      </td>
                      <td className="text-right py-2 px-3 tabular-nums">
                        {checked.toLocaleString()}
                      </td>
                      <td className="text-right py-2 px-3 tabular-nums">
                        {t.verdicts.unchecked.toLocaleString()}
                      </td>
                      <td
                        className={`text-right py-2 px-3 tabular-nums font-medium ${
                          t.coveragePercent >= 80
                            ? "text-emerald-600"
                            : t.coveragePercent >= 40
                              ? "text-amber-600"
                              : "text-red-600"
                        }`}
                      >
                        {t.coveragePercent}%
                      </td>
                      <td
                        className={`text-right py-2 px-3 tabular-nums font-medium ${
                          t.greenPercent >= 80
                            ? "text-emerald-600"
                            : t.greenPercent >= 50
                              ? "text-amber-600"
                              : "text-red-600"
                        }`}
                      >
                        {t.greenPercent}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border/60 font-semibold">
                  <td className="py-2 px-3">Totals</td>
                  <td className="text-right py-2 px-3 tabular-nums">
                    {coverageMatrix.totals.totalRecords.toLocaleString()}
                  </td>
                  <td colSpan={2} className="text-right py-2 px-3 tabular-nums">
                    {coverageMatrix.totals.totalVerdicts.toLocaleString()} verdicts
                  </td>
                  <td className="text-right py-2 px-3 tabular-nums">
                    {coverageMatrix.totals.coveragePercent}%
                  </td>
                  <td className="text-right py-2 px-3 tabular-nums">
                    {coverageMatrix.totals.confirmedPercent}%
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ── (e) Verdict Heatmap ──────────────────────────────────────── */}
      {Object.keys(verdictMatrix.matrix).length > 0 && (() => {
        const allVerdictTypes = [
          "confirmed",
          "partial",
          "unverifiable",
          "contradicted",
          "outdated",
          "unchecked",
        ];
        // Include all record types from coverage matrix (not just those with verdicts)
        // so that zero-verdict types still appear in the heatmap
        const recordTypes = Array.from(new Set([
          ...coverageMatrix.tables.map((t) => t.recordType),
          ...Object.keys(verdictMatrix.matrix),
        ])).sort();

        // Find max count for color intensity scaling
        let maxCount = 0;
        for (const rt of recordTypes) {
          for (const v of allVerdictTypes) {
            const val = verdictMatrix.matrix[rt]?.[v] ?? 0;
            if (val > maxCount) maxCount = val;
          }
        }

        const VERDICT_RGB: Record<string, string> = {
          confirmed: "16, 185, 129",    // emerald-500
          partial: "251, 191, 36",      // amber-400
          unverifiable: "251, 146, 60", // orange-400
          contradicted: "239, 68, 68",  // red-500
          outdated: "245, 158, 11",     // amber-500
          unchecked: "209, 213, 219",   // gray-300
        };

        const cellStyle = (verdict: string, count: number): React.CSSProperties => {
          if (count === 0) return {};
          const rgb = VERDICT_RGB[verdict];
          if (!rgb) return {};
          const opacity = maxCount > 0 ? Math.max(0.1, (count / maxCount) * 0.5) : 0;
          return { backgroundColor: `rgba(${rgb}, ${opacity})` };
        };

        return (
          <div className="not-prose mb-8">
            <h2 className="text-lg font-semibold mb-3">
              Verdict Heatmap
            </h2>
            <p className="text-sm text-muted-foreground mb-3">
              Cross-tabulation of verdict counts per record type. Color intensity indicates
              relative count (darker = more records).
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border/60">
                    <th className="text-left py-2 px-3 font-medium">Record Type</th>
                    {allVerdictTypes.map((v) => (
                      <th
                        key={v}
                        className={`text-right py-2 px-3 font-medium capitalize ${VERDICT_COLORS[v] ?? ""}`}
                      >
                        {v}
                      </th>
                    ))}
                    <th className="text-right py-2 px-3 font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {recordTypes.map((rt) => {
                    const row = verdictMatrix.matrix[rt] ?? {};
                    const rowTotal = allVerdictTypes.reduce(
                      (s, v) => s + (row[v] ?? 0),
                      0
                    );
                    return (
                      <tr
                        key={rt}
                        className="border-b border-border/30 hover:bg-muted/30"
                      >
                        <td className="py-2 px-3 font-medium">{rt}</td>
                        {allVerdictTypes.map((v) => {
                          const val = row[v] ?? 0;
                          return (
                            <td
                              key={v}
                              className="text-right py-2 px-3 tabular-nums"
                              style={cellStyle(v, val)}
                            >
                              {val > 0 ? val.toLocaleString() : (
                                <span className="text-muted-foreground/50">0</span>
                              )}
                            </td>
                          );
                        })}
                        <td className="text-right py-2 px-3 tabular-nums font-medium">
                          {rowTotal.toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border/60 font-semibold">
                    <td className="py-2 px-3">Totals</td>
                    {allVerdictTypes.map((v) => (
                      <td
                        key={v}
                        className={`text-right py-2 px-3 tabular-nums ${VERDICT_COLORS[v] ?? ""}`}
                      >
                        {(verdictMatrix.totals[v] ?? 0).toLocaleString()}
                      </td>
                    ))}
                    <td className="text-right py-2 px-3 tabular-nums">
                      {Object.values(verdictMatrix.totals)
                        .reduce((s, c) => s + c, 0)
                        .toLocaleString()}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        );
      })()}

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
