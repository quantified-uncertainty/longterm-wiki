import {
  fetchDetailed,
  withApiFallback,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { getTypedEntities } from "@data/tablebase";

// ── Types ─────────────────────────────────────────────────────────────────

/** Stats shape returned by GET /api/sourcing/stats (unified) */
interface UnifiedSourcingStatsResult {
  total: number;
  needs_recheck: number;
  by_verdict: Record<string, number>;
  by_type: Record<string, number>;
}

/**
 * Shape returned by GET /api/sourcing/coverage-matrix.
 *
 * QUA-928: coverage is split into three explicit percentages so the dashboard
 * can show authoring-quality (`checkabilityPercent`) separately from
 * verification-quality (`checkableCoveragePercent`). The previous
 * `coveragePercent` field was ambiguous — it equaled
 * `checkedRecords / totalRecords`, which conflated "no source supplied" with
 * "source supplied but not yet checked".
 *
 * The new fields are typed as optional so the dashboard can render against
 * a wiki-server that hasn't been deployed yet (the web build fetches data
 * from prod at SSG time). Once the server-side change ships and the next
 * web build runs, the `??` fallbacks become no-ops.
 */
interface CoverageMatrixResult {
  tables: Array<{
    recordType: string;
    totalRecords: number;
    checkableRecords?: number;
    checkedRecords?: number;
    verdicts: {
      confirmed: number;
      partial: number;
      unverifiable: number;
      contradicted: number;
      outdated: number;
      unchecked: number;
    };
    /** checkable / total — what fraction of authored records are eligible for sourcing */
    checkabilityPercent?: number;
    /** checked / checkable — what fraction of checkable records have a verdict */
    checkableCoveragePercent?: number;
    /** checked / total — joint metric (capped by checkability) */
    fullCoveragePercent?: number;
    /** @deprecated Use fullCoveragePercent. Kept here for the SSG-against-old-prod transition window. */
    coveragePercent?: number;
    greenPercent: number;
    /** Whether this record type is exempt from sourcing verification */
    exempt?: boolean;
  }>;
  totals: {
    totalRecords: number;
    checkableRecords?: number;
    /**
     * QUA-928 review: aggregate sum of per-record `checkedRecords`
     * (records with at least one verdict). Distinct from `totalVerdicts`,
     * which can over-count because a single record may produce multiple
     * per-field verdict rows.
     */
    checkedRecords?: number;
    totalVerdicts: number;
    confirmedPercent: number;
    checkabilityPercent?: number;
    checkableCoveragePercent?: number;
    fullCoveragePercent?: number;
    /** @deprecated Use fullCoveragePercent. */
    coveragePercent?: number;
  };
  /** Record types that are exempt from sourcing verification */
  exemptTypes?: string[];
}

/** Shape returned by GET /api/sourcing/verdict-matrix */
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
  unverifiable: "text-red-600",
  unchecked: "text-muted-foreground",
};

const BAR_COLORS: Record<string, string> = {
  confirmed: "bg-emerald-500",
  contradicted: "bg-red-500",
  outdated: "bg-amber-500",
  partial: "bg-amber-400",
  unverifiable: "bg-red-400",
  unchecked: "bg-gray-300",
};

// ── Data loading ──────────────────────────────────────────────────────────

function emptySourcingStats(): UnifiedSourcingStatsResult {
  return {
    total: 0,
    needs_recheck: 0,
    by_verdict: {},
    by_type: {},
  };
}

async function loadSourcingStats() {
  return fetchDetailed<UnifiedSourcingStatsResult>("/api/sourcing/stats", {
    revalidate: 60,
  });
}

function emptyCoverageMatrix(): CoverageMatrixResult {
  return {
    tables: [],
    totals: {
      totalRecords: 0,
      checkableRecords: 0,
      totalVerdicts: 0,
      confirmedPercent: 0,
      checkabilityPercent: 0,
      checkableCoveragePercent: 0,
      fullCoveragePercent: 0,
    },
  };
}

async function loadCoverageMatrix() {
  return fetchDetailed<CoverageMatrixResult>("/api/sourcing/coverage-matrix", {
    revalidate: 60,
  });
}

function emptyVerdictMatrix(): VerdictMatrixResult {
  return { matrix: {}, totals: {} };
}

async function loadVerdictMatrix() {
  return fetchDetailed<VerdictMatrixResult>("/api/sourcing/verdict-matrix", {
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

export async function SourcingCoverageContent() {
  const [sourcingResult, coverageMatrixResult, verdictMatrixResult] = await Promise.all([
    withApiFallback(loadSourcingStats, emptySourcingStats),
    withApiFallback(loadCoverageMatrix, emptyCoverageMatrix),
    withApiFallback(loadVerdictMatrix, emptyVerdictMatrix),
  ]);

  const vStats: UnifiedSourcingStatsResult = {
    ...emptySourcingStats(),
    ...sourcingResult.data,
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
  const allResults = [sourcingResult, coverageMatrixResult, verdictMatrixResult];
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

  // Verdict distribution from unified sourcing system
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
            All verdicts from the unified sourcing system.
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
      {coverageMatrix.tables.length > 0 && (() => {
        const exemptSet = new Set(coverageMatrix.exemptTypes ?? []);
        const nonExemptTables = coverageMatrix.tables.filter((t) => !t.exempt && !exemptSet.has(t.recordType));
        const exemptTables = coverageMatrix.tables.filter((t) => t.exempt || exemptSet.has(t.recordType));

        return (
        <div className="not-prose mb-8">
          <h2 className="text-lg font-semibold mb-3">
            Coverage Matrix
          </h2>
          <p className="text-sm text-muted-foreground mb-3">
            Per-record-type breakdown of the sourcing pipeline. <strong>Checkability</strong> is the
            authoring-quality metric (fraction of records eligible for sourcing — has a source
            URL and a verifiable property). <strong>Checkable Coverage</strong> is the verification
            metric the orchestrator gates on (of the eligible records, fraction with a verdict).
            <strong> Full Coverage</strong> is verified ÷ total, capped by checkability.
            {exemptTables.length > 0 && (
              <> Exempt types (data ingested from canonical APIs) are shown separately and excluded from totals.</>
            )}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border/60">
                  <th className="text-left py-2 px-3 font-medium">Record Type</th>
                  <th className="text-right py-2 px-3 font-medium">Total</th>
                  <th className="text-right py-2 px-3 font-medium">Checkable</th>
                  <th className="text-right py-2 px-3 font-medium">Checked</th>
                  <th
                    className="text-right py-2 px-3 font-medium"
                    title="Checkable / Total — authoring quality"
                  >
                    Checkability %
                  </th>
                  <th
                    className="text-right py-2 px-3 font-medium"
                    title="Checked / Checkable — verification quality (gate metric)"
                  >
                    Checkable Cov %
                  </th>
                  <th
                    className="text-right py-2 px-3 font-medium"
                    title="Checked / Total — joint metric, capped by checkability"
                  >
                    Full Cov %
                  </th>
                  <th className="text-right py-2 px-3 font-medium">Green %</th>
                </tr>
              </thead>
              <tbody>
                {nonExemptTables.map((t) => {
                  // Fall back to legacy field shape during the
                  // wiki-server-not-yet-deployed window. Once both ship,
                  // the `??` paths become unreachable.
                  const checkable = t.checkableRecords ?? t.totalRecords;
                  const checked = t.checkedRecords ?? 0;
                  const checkability =
                    t.checkabilityPercent ??
                    (t.totalRecords > 0
                      ? Math.round((checkable / t.totalRecords) * 1000) / 10
                      : 0);
                  const checkableCov =
                    t.checkableCoveragePercent ??
                    (checkable > 0
                      ? Math.round((checked / checkable) * 1000) / 10
                      : 0);
                  const fullCov =
                    t.fullCoveragePercent ??
                    t.coveragePercent ??
                    (t.totalRecords > 0
                      ? Math.round((checked / t.totalRecords) * 1000) / 10
                      : 0);
                  const checkabilityGap =
                    t.totalRecords > 0
                      ? Math.round(((t.totalRecords - checkable) / t.totalRecords) * 1000) / 10
                      : 0;
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
                        {checkable.toLocaleString()}
                      </td>
                      <td className="text-right py-2 px-3 tabular-nums">
                        {checked.toLocaleString()}
                      </td>
                      <td
                        className={`text-right py-2 px-3 tabular-nums font-medium ${
                          checkability >= 95
                            ? "text-muted-foreground"
                            : checkability >= 80
                              ? "text-amber-600"
                              : "text-red-600"
                        }`}
                        title={
                          checkabilityGap > 0
                            ? `${checkabilityGap}% of records lack a source URL or are on a non-verifiable property`
                            : undefined
                        }
                      >
                        {checkability}%
                      </td>
                      <td
                        className={`text-right py-2 px-3 tabular-nums font-medium ${
                          checkableCov >= 90
                            ? "text-emerald-600"
                            : checkableCov >= 60
                              ? "text-amber-600"
                              : "text-red-600"
                        }`}
                      >
                        {checkableCov}%
                      </td>
                      <td
                        className={`text-right py-2 px-3 tabular-nums ${
                          fullCov >= 80
                            ? "text-emerald-600"
                            : fullCov >= 40
                              ? "text-amber-600"
                              : "text-muted-foreground"
                        }`}
                      >
                        {fullCov}%
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
                {exemptTables.length > 0 && (
                  <>
                    <tr className="border-t border-border/40">
                      <td colSpan={8} className="py-2 px-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Exempt (canonical API sources)
                      </td>
                    </tr>
                    {exemptTables.map((t) => (
                      <tr
                        key={t.recordType}
                        className="border-b border-border/30 hover:bg-muted/30 opacity-60"
                      >
                        <td className="py-2 px-3 font-medium text-muted-foreground">
                          {t.recordType}
                          <span className="ml-2 text-xs bg-muted px-1.5 py-0.5 rounded">exempt</span>
                        </td>
                        <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">
                          {t.totalRecords.toLocaleString()}
                        </td>
                        <td colSpan={6} className="text-center py-2 px-3 text-xs text-muted-foreground italic">
                          Not subject to sourcing verification
                        </td>
                      </tr>
                    ))}
                  </>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border/60 font-semibold">
                  <td className="py-2 px-3">
                    Totals
                    {exemptTables.length > 0 && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">(excl. exempt)</span>
                    )}
                  </td>
                  <td className="text-right py-2 px-3 tabular-nums">
                    {coverageMatrix.totals.totalRecords.toLocaleString()}
                  </td>
                  <td className="text-right py-2 px-3 tabular-nums">
                    {(coverageMatrix.totals.checkableRecords ?? coverageMatrix.totals.totalRecords).toLocaleString()}
                  </td>
                  <td className="text-right py-2 px-3 tabular-nums">
                    {/* QUA-928 review: prefer aggregate checkedRecords (one per
                       record); fall back to totalVerdicts for the deploy
                       window where the wiki-server may not have shipped the
                       new field yet. */}
                    {coverageMatrix.totals.checkedRecords !== undefined
                      ? coverageMatrix.totals.checkedRecords.toLocaleString()
                      : `${coverageMatrix.totals.totalVerdicts.toLocaleString()} verdicts`}
                  </td>
                  <td className="text-right py-2 px-3 tabular-nums">
                    {/* QUA-928 review: render `%` only for numeric values to
                       avoid the "—%" placeholder when the field is absent. */}
                    {typeof coverageMatrix.totals.checkabilityPercent === "number"
                      ? `${coverageMatrix.totals.checkabilityPercent}%`
                      : "—"}
                  </td>
                  <td className="text-right py-2 px-3 tabular-nums">
                    {typeof coverageMatrix.totals.checkableCoveragePercent === "number"
                      ? `${coverageMatrix.totals.checkableCoveragePercent}%`
                      : "—"}
                  </td>
                  <td className="text-right py-2 px-3 tabular-nums">
                    {(() => {
                      const v =
                        coverageMatrix.totals.fullCoveragePercent ??
                        coverageMatrix.totals.coveragePercent;
                      return typeof v === "number" ? `${v}%` : "—";
                    })()}
                  </td>
                  <td className="text-right py-2 px-3 tabular-nums">
                    {coverageMatrix.totals.confirmedPercent}%
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        );
      })()}

      {/* ── (e) Verdict Heatmap ──────────────────────────────────────── */}
      {(Object.keys(verdictMatrix.matrix).length > 0 || coverageMatrix.tables.length > 0) && (() => {
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

        // Build lookup from coverage matrix for total record counts per type
        const totalRecordsByType = new Map<string, number>();
        for (const t of coverageMatrix.tables) {
          totalRecordsByType.set(t.recordType, t.totalRecords);
        }

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
          unverifiable: "248, 113, 113", // red-400
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
                    <th className="text-right py-2 px-3 font-medium">Records</th>
                    {allVerdictTypes.map((v) => (
                      <th
                        key={v}
                        className={`text-right py-2 px-3 font-medium capitalize ${VERDICT_COLORS[v] ?? ""}`}
                      >
                        {v}
                      </th>
                    ))}
                    <th className="text-right py-2 px-3 font-medium">Verdicts</th>
                    <th className="text-right py-2 px-3 font-medium">Coverage</th>
                  </tr>
                </thead>
                <tbody>
                  {recordTypes.map((rt) => {
                    const row = verdictMatrix.matrix[rt] ?? {};
                    const rowTotal = allVerdictTypes.reduce(
                      (s, v) => s + (row[v] ?? 0),
                      0
                    );
                    // Coverage numerator excludes `unchecked` to match the
                    // checked-coverage definition used elsewhere on the page.
                    const checkedTotal = allVerdictTypes
                      .filter((v) => v !== "unchecked")
                      .reduce((s, v) => s + (row[v] ?? 0), 0);
                    const totalRecords = totalRecordsByType.get(rt);
                    const coveragePct = totalRecords != null && totalRecords > 0
                      ? Math.round((checkedTotal / totalRecords) * 100)
                      : null;
                    return (
                      <tr
                        key={rt}
                        className="border-b border-border/30 hover:bg-muted/30"
                      >
                        <td className="py-2 px-3 font-medium">{rt}</td>
                        <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">
                          {totalRecords != null ? totalRecords.toLocaleString() : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
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
                        <td className={`text-right py-2 px-3 tabular-nums font-medium ${
                          coveragePct == null ? "text-muted-foreground/50"
                            : coveragePct >= 80 ? "text-emerald-600"
                            : coveragePct >= 40 ? "text-amber-600"
                            : "text-red-600"
                        }`}>
                          {coveragePct != null ? `${coveragePct}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  {(() => {
                    const totalAllRecords = coverageMatrix.totals.totalRecords;
                    const totalAllVerdicts = Object.values(verdictMatrix.totals)
                      .reduce((s, c) => s + c, 0);
                    // Coverage numerator excludes `unchecked` to match the
                    // checked-coverage definition used elsewhere on the page.
                    const totalCheckedVerdicts = allVerdictTypes
                      .filter((v) => v !== "unchecked")
                      .reduce((s, v) => s + (verdictMatrix.totals[v] ?? 0), 0);
                    const totalCoverage = totalAllRecords > 0
                      ? Math.round((totalCheckedVerdicts / totalAllRecords) * 100)
                      : null;
                    return (
                      <tr className="border-t-2 border-border/60 font-semibold">
                        <td className="py-2 px-3">Totals</td>
                        <td className="text-right py-2 px-3 tabular-nums">
                          {totalAllRecords > 0 ? totalAllRecords.toLocaleString() : "—"}
                        </td>
                        {allVerdictTypes.map((v) => (
                          <td
                            key={v}
                            className={`text-right py-2 px-3 tabular-nums ${VERDICT_COLORS[v] ?? ""}`}
                          >
                            {(verdictMatrix.totals[v] ?? 0).toLocaleString()}
                          </td>
                        ))}
                        <td className="text-right py-2 px-3 tabular-nums">
                          {totalAllVerdicts.toLocaleString()}
                        </td>
                        <td className={`text-right py-2 px-3 tabular-nums ${
                          totalCoverage == null ? ""
                            : totalCoverage >= 80 ? "text-emerald-600"
                            : totalCoverage >= 40 ? "text-amber-600"
                            : "text-red-600"
                        }`}>
                          {totalCoverage != null ? `${totalCoverage}%` : "—"}
                        </td>
                      </tr>
                    );
                  })()}
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
