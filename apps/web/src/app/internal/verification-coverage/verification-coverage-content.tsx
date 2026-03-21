import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { getTypedEntities } from "@data/tablebase";

// ── Types ─────────────────────────────────────────────────────────────────

/** Stats shape returned by GET /api/things/stats */
interface ThingsStatsResult {
  total: number;
  byType: Record<string, number>;
  byVerdict: Record<string, number>;
  byEntityType: Record<string, number>;
}

/** Stats shape returned by GET /api/kb-verifications/stats */
interface KbStatsResult {
  total_facts: number;
  avg_confidence: number;
  needs_recheck: number;
  by_verdict: Record<string, number>;
}

/** Stats shape returned by GET /api/record-verifications/stats */
interface RecordVerificationStatsResult {
  total_records: number;
  total_verdicts: number;
  avg_confidence: number;
  needs_recheck: number;
  by_verdict: Record<string, number>;
  by_record_type: Record<
    string,
    { total: number; verified: number; by_verdict: Record<string, number> }
  >;
  staleness: {
    over_30_days: number;
    over_90_days: number;
    over_180_days: number;
  };
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

async function loadThingsStats(): Promise<FetchResult<ThingsStatsResult>> {
  return fetchDetailed<ThingsStatsResult>("/api/things/stats", {
    revalidate: 60,
  });
}

async function loadKbStats(): Promise<FetchResult<KbStatsResult>> {
  return fetchDetailed<KbStatsResult>("/api/kb-verifications/stats", {
    revalidate: 60,
  });
}

async function loadRecordVerificationStats(): Promise<
  FetchResult<RecordVerificationStatsResult>
> {
  return fetchDetailed<RecordVerificationStatsResult>(
    "/api/record-verifications/stats",
    { revalidate: 60 }
  );
}

function emptyThingsStats(): ThingsStatsResult {
  return { total: 0, byType: {}, byVerdict: {}, byEntityType: {} };
}

function emptyKbStats(): KbStatsResult {
  return {
    total_facts: 0,
    avg_confidence: 0,
    needs_recheck: 0,
    by_verdict: {},
  };
}

function emptyRecordStats(): RecordVerificationStatsResult {
  return {
    total_records: 0,
    total_verdicts: 0,
    avg_confidence: 0,
    needs_recheck: 0,
    by_verdict: {},
    by_record_type: {},
    staleness: { over_30_days: 0, over_90_days: 0, over_180_days: 0 },
  };
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

// ── Coverage percentage color ─────────────────────────────────────────────

function coverageColor(pct: number): string {
  if (pct < 25) return "text-red-600";
  if (pct < 75) return "text-amber-600";
  return "text-emerald-600";
}

// ── Main Component ────────────────────────────────────────────────────────

export async function VerificationCoverageContent() {
  // Load all three data sources in parallel
  const [thingsResult, kbResult, recordResult] = await Promise.all([
    withApiFallback(loadThingsStats, emptyThingsStats),
    withApiFallback(loadKbStats, emptyKbStats),
    withApiFallback(loadRecordVerificationStats, emptyRecordStats),
  ]);

  // Merge with defaults to guard against undefined fields from unavailable API
  const thingsStats = { ...emptyThingsStats(), ...thingsResult.data };
  const kbStats = { ...emptyKbStats(), ...kbResult.data };
  const recordStats = { ...emptyRecordStats(), ...recordResult.data };

  // Determine overall source and error
  const source = thingsResult.source === "api" ? "api" as const : "local" as const;
  const apiError =
    thingsResult.apiError || kbResult.apiError || recordResult.apiError;

  // Local entity data for coverage by type
  const entities = getTypedEntities();
  const entityCountByType = new Map<string, number>();
  for (const e of entities) {
    const t = e.entityType;
    entityCountByType.set(t, (entityCountByType.get(t) ?? 0) + 1);
  }
  const totalEntities = entities.length;

  // Compute verified entities from things stats (non-unchecked verdicts)
  const thingsVerified = Object.entries(thingsStats.byVerdict ?? {})
    .filter(([v]) => v !== "unchecked")
    .reduce((sum, [, c]) => sum + c, 0);
  const pctVerified =
    (thingsStats.total ?? 0) > 0
      ? Math.round((thingsVerified / thingsStats.total) * 100)
      : 0;

  // Combine all verdicts across systems for overall distribution
  const combinedVerdicts = new Map<string, number>();
  for (const [v, c] of Object.entries(thingsStats.byVerdict ?? {})) {
    combinedVerdicts.set(v, (combinedVerdicts.get(v) ?? 0) + c);
  }
  for (const [v, c] of Object.entries(kbStats.by_verdict ?? {})) {
    combinedVerdicts.set(v, (combinedVerdicts.get(v) ?? 0) + c);
  }
  for (const [v, c] of Object.entries(recordStats.by_verdict ?? {})) {
    combinedVerdicts.set(v, (combinedVerdicts.get(v) ?? 0) + c);
  }
  const combinedVerdictEntries = [...combinedVerdicts.entries()].sort(
    ([, a], [, b]) => b - a
  );
  const totalCombinedVerdicts = combinedVerdictEntries.reduce(
    (s, [, c]) => s + c,
    0
  );

  // Average confidence across systems (weighted)
  let avgConfidence = 0;
  let weightTotal = 0;
  if (kbStats.total_facts > 0) {
    avgConfidence += kbStats.avg_confidence * kbStats.total_facts;
    weightTotal += kbStats.total_facts;
  }
  if (recordStats.total_verdicts > 0) {
    avgConfidence += recordStats.avg_confidence * recordStats.total_verdicts;
    weightTotal += recordStats.total_verdicts;
  }
  const overallAvgConfidence =
    weightTotal > 0 ? avgConfidence / weightTotal : 0;

  // Total needs recheck
  const totalNeedsRecheck =
    kbStats.needs_recheck + recordStats.needs_recheck;

  // Staleness data (from record verifications)
  const staleness = recordStats.staleness ?? { over_30_days: 0, over_90_days: 0, over_180_days: 0 };

  // Coverage by entity type — combine local entity counts with things byEntityType
  const entityTypes = [...entityCountByType.keys()].sort();
  const coverageByType = entityTypes.map((type) => {
    const total = entityCountByType.get(type) ?? 0;
    const thingsOfType = thingsStats.byEntityType[type] ?? 0;
    const pct = total > 0 ? Math.round((thingsOfType / total) * 100) : 0;
    return {
      type,
      total,
      indexed: thingsOfType,
      pct,
    };
  });

  // Record-type coverage
  const recordTypeEntries = Object.entries(recordStats.by_record_type ?? {})
    .sort(([, a], [, b]) => b.total - a.total);

  // Priority entities — sorted by most entities without coverage
  const priorityTypes = coverageByType
    .filter((c) => c.pct < 100 && c.total > 0)
    .sort((a, b) => b.total - b.indexed - (a.total - a.indexed))
    .slice(0, 10);

  return (
    <>
      <DataSourceBanner source={source} apiError={apiError} />

      <p className="text-muted-foreground text-sm leading-relaxed mb-6">
        Cross-system verification coverage across FactBase facts, record
        verifications, and the universal Things index. This dashboard unifies
        data from{" "}
        <code className="text-[11px]">kb_fact_verdicts</code>,{" "}
        <code className="text-[11px]">record_verdicts</code>, and{" "}
        <code className="text-[11px]">thing_verdicts</code> tables.
      </p>

      {/* ── (a) Summary cards ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 not-prose mb-8">
        <StatCard
          label="Total Entities"
          value={totalEntities.toLocaleString()}
          sub={`${entityTypes.length} entity types`}
        />
        <StatCard
          label="% Indexed in Things"
          value={`${pctVerified}%`}
          sub={`${(thingsVerified ?? 0).toLocaleString()} of ${(thingsStats.total ?? 0).toLocaleString()} things`}
          color={coverageColor(pctVerified)}
        />
        <StatCard
          label="Avg Confidence"
          value={
            overallAvgConfidence > 0
              ? `${Math.round(overallAvgConfidence * 100)}%`
              : "N/A"
          }
          sub={`Across ${(weightTotal ?? 0).toLocaleString()} verdicts`}
        />
        <StatCard
          label="Needs Recheck"
          value={(totalNeedsRecheck ?? 0).toLocaleString()}
          color={totalNeedsRecheck > 0 ? "text-amber-600" : ""}
          sub={
            totalNeedsRecheck > 0
              ? `${kbStats.needs_recheck ?? 0} facts, ${recordStats.needs_recheck ?? 0} records`
              : "All up to date"
          }
        />
        <StatCard
          label="FactBase Facts Checked"
          value={(kbStats.total_facts ?? 0).toLocaleString()}
          sub={`${(recordStats.total_verdicts ?? 0).toLocaleString()} record verdicts`}
        />
      </div>

      {/* ── (b) Coverage by Entity Type ────────────────────────────────── */}
      <div className="not-prose mb-8">
        <h2 className="text-lg font-semibold mb-3">
          Coverage by Entity Type
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border/60">
                <th className="text-left py-2 px-3 font-medium">
                  Entity Type
                </th>
                <th className="text-right py-2 px-3 font-medium">Total</th>
                <th className="text-right py-2 px-3 font-medium">
                  In Things Index
                </th>
                <th className="text-right py-2 px-3 font-medium">
                  Not Indexed
                </th>
                <th className="text-right py-2 px-3 font-medium">
                  % Coverage
                </th>
              </tr>
            </thead>
            <tbody>
              {coverageByType
                .sort((a, b) => b.total - a.total)
                .map((row) => (
                  <tr
                    key={row.type}
                    className="border-b border-border/30 hover:bg-muted/30"
                  >
                    <td className="py-2 px-3 font-medium">{row.type}</td>
                    <td className="text-right py-2 px-3 tabular-nums">
                      {row.total}
                    </td>
                    <td className="text-right py-2 px-3 tabular-nums">
                      {row.indexed}
                    </td>
                    <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">
                      {row.total - row.indexed}
                    </td>
                    <td
                      className={`text-right py-2 px-3 tabular-nums font-medium ${coverageColor(row.pct)}`}
                    >
                      {row.pct}%
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
                <td className="text-right py-2 px-3 tabular-nums">
                  {coverageByType.reduce((s, r) => s + r.indexed, 0)}
                </td>
                <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">
                  {totalEntities -
                    coverageByType.reduce((s, r) => s + r.indexed, 0)}
                </td>
                <td
                  className={`text-right py-2 px-3 tabular-nums font-medium ${coverageColor(
                    totalEntities > 0
                      ? Math.round(
                          (coverageByType.reduce(
                            (s, r) => s + r.indexed,
                            0
                          ) /
                            totalEntities) *
                            100
                        )
                      : 0
                  )}`}
                >
                  {totalEntities > 0
                    ? Math.round(
                        (coverageByType.reduce(
                          (s, r) => s + r.indexed,
                          0
                        ) /
                          totalEntities) *
                          100
                      )
                    : 0}
                  %
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* ── (c) Verdict Distribution ───────────────────────────────────── */}
      {combinedVerdictEntries.length > 0 && (
        <div className="not-prose mb-8">
          <h2 className="text-lg font-semibold mb-3">
            Combined Verdict Distribution
          </h2>
          <p className="text-sm text-muted-foreground mb-3">
            All verdicts across FactBase, record verifications, and Things
            index.
          </p>

          {/* Badges */}
          <div className="flex gap-2 flex-wrap mb-4">
            {combinedVerdictEntries.map(([verdict, count]) => (
              <span
                key={verdict}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-muted ${VERDICT_COLORS[verdict] || "text-muted-foreground"}`}
              >
                {verdict}
                <span className="tabular-nums font-semibold">{count}</span>
                <span className="text-muted-foreground">
                  (
                  {totalCombinedVerdicts > 0
                    ? Math.round((count / totalCombinedVerdicts) * 100)
                    : 0}
                  %)
                </span>
              </span>
            ))}
          </div>

          {/* Distribution bar */}
          {totalCombinedVerdicts > 0 && (
            <div className="mb-4">
              <div className="flex rounded-full overflow-hidden h-4">
                {combinedVerdictEntries.map(([verdict, count]) => (
                  <div
                    key={verdict}
                    className={BAR_COLORS[verdict] || "bg-gray-300"}
                    style={{
                      width: `${(count / totalCombinedVerdicts) * 100}%`,
                    }}
                    title={`${verdict}: ${count}`}
                  />
                ))}
              </div>
              <div className="flex justify-between text-xs text-muted-foreground mt-1 flex-wrap gap-x-4">
                {combinedVerdictEntries.map(([verdict, count]) => (
                  <span key={verdict}>
                    {verdict}:{" "}
                    {Math.round(
                      (count / totalCombinedVerdicts) * 100
                    )}
                    %
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Per-system breakdown */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
            {/* FactBase */}
            <div className="rounded-lg border border-border/60 p-4">
              <h3 className="text-sm font-semibold mb-2">
                FactBase Verdicts
              </h3>
              <p className="text-xs text-muted-foreground mb-2">
                {kbStats.total_facts} facts checked
              </p>
              {Object.entries(kbStats.by_verdict ?? {}).length > 0 ? (
                <div className="space-y-1">
                  {Object.entries(kbStats.by_verdict ?? {})
                    .sort(([, a], [, b]) => b - a)
                    .map(([verdict, count]) => (
                      <div
                        key={verdict}
                        className="flex justify-between text-xs"
                      >
                        <span
                          className={
                            VERDICT_COLORS[verdict] ||
                            "text-muted-foreground"
                          }
                        >
                          {verdict}
                        </span>
                        <span className="tabular-nums">{count}</span>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No verdicts recorded
                </p>
              )}
            </div>

            {/* Record verifications */}
            <div className="rounded-lg border border-border/60 p-4">
              <h3 className="text-sm font-semibold mb-2">
                Record Verdicts
              </h3>
              <p className="text-xs text-muted-foreground mb-2">
                {recordStats.total_verdicts} verdicts across{" "}
                {recordStats.total_records} records
              </p>
              {Object.entries(recordStats.by_verdict ?? {}).length > 0 ? (
                <div className="space-y-1">
                  {Object.entries(recordStats.by_verdict ?? {})
                    .sort(([, a], [, b]) => b - a)
                    .map(([verdict, count]) => (
                      <div
                        key={verdict}
                        className="flex justify-between text-xs"
                      >
                        <span
                          className={
                            VERDICT_COLORS[verdict] ||
                            "text-muted-foreground"
                          }
                        >
                          {verdict}
                        </span>
                        <span className="tabular-nums">{count}</span>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No verdicts recorded
                </p>
              )}
            </div>

            {/* Things verdicts */}
            <div className="rounded-lg border border-border/60 p-4">
              <h3 className="text-sm font-semibold mb-2">
                Things Verdicts
              </h3>
              <p className="text-xs text-muted-foreground mb-2">
                {thingsStats.total} total things
              </p>
              {Object.entries(thingsStats.byVerdict ?? {}).length > 0 ? (
                <div className="space-y-1">
                  {Object.entries(thingsStats.byVerdict ?? {})
                    .sort(([, a], [, b]) => b - a)
                    .map(([verdict, count]) => (
                      <div
                        key={verdict}
                        className="flex justify-between text-xs"
                      >
                        <span
                          className={
                            VERDICT_COLORS[verdict] ||
                            "text-muted-foreground"
                          }
                        >
                          {verdict}
                        </span>
                        <span className="tabular-nums">{count}</span>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No verdicts recorded
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── (d) Staleness Report ───────────────────────────────────────── */}
      <div className="not-prose mb-8">
        <h2 className="text-lg font-semibold mb-3">Staleness Report</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Age of record verifications. Stale verifications may no longer
          reflect current data.
        </p>
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-border/60 p-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">
              &gt; 30 days old
            </p>
            <p
              className={`text-2xl font-bold tabular-nums ${staleness.over_30_days > 0 ? "text-amber-500" : "text-emerald-600"}`}
            >
              {staleness.over_30_days}
            </p>
          </div>
          <div className="rounded-lg border border-border/60 p-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">
              &gt; 90 days old
            </p>
            <p
              className={`text-2xl font-bold tabular-nums ${staleness.over_90_days > 0 ? "text-amber-600" : "text-emerald-600"}`}
            >
              {staleness.over_90_days}
            </p>
          </div>
          <div className="rounded-lg border border-border/60 p-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">
              &gt; 180 days old
            </p>
            <p
              className={`text-2xl font-bold tabular-nums ${staleness.over_180_days > 0 ? "text-red-600" : "text-emerald-600"}`}
            >
              {staleness.over_180_days}
            </p>
          </div>
        </div>
      </div>

      {/* ── (e) Record Type Coverage ───────────────────────────────────── */}
      {recordTypeEntries.length > 0 && (
        <div className="not-prose mb-8">
          <h2 className="text-lg font-semibold mb-3">
            Record Type Coverage
          </h2>
          <p className="text-sm text-muted-foreground mb-3">
            Verification status broken down by record type (grants, personnel,
            divisions, etc.).
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border/60">
                  <th className="text-left py-2 px-3 font-medium">
                    Record Type
                  </th>
                  <th className="text-right py-2 px-3 font-medium">
                    Total
                  </th>
                  <th className="text-right py-2 px-3 font-medium">
                    Verified
                  </th>
                  <th className="text-right py-2 px-3 font-medium">
                    Unverified
                  </th>
                  <th className="text-right py-2 px-3 font-medium">
                    % Coverage
                  </th>
                </tr>
              </thead>
              <tbody>
                {recordTypeEntries.map(([type, data]) => {
                  const pct =
                    data.total > 0
                      ? Math.round((data.verified / data.total) * 100)
                      : 0;
                  return (
                    <tr
                      key={type}
                      className="border-b border-border/30 hover:bg-muted/30"
                    >
                      <td className="py-2 px-3 font-medium">{type}</td>
                      <td className="text-right py-2 px-3 tabular-nums">
                        {data.total}
                      </td>
                      <td className="text-right py-2 px-3 tabular-nums">
                        {data.verified}
                      </td>
                      <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">
                        {data.total - data.verified}
                      </td>
                      <td
                        className={`text-right py-2 px-3 tabular-nums font-medium ${coverageColor(pct)}`}
                      >
                        {pct}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── (f) Priority Queue — Types needing coverage ────────────────── */}
      {priorityTypes.length > 0 && (
        <div className="not-prose mb-8">
          <h2 className="text-lg font-semibold mb-3">
            Priority: Entity Types Needing Coverage
          </h2>
          <p className="text-sm text-muted-foreground mb-3">
            Entity types ranked by the number of entities not yet indexed in
            the Things table. Focus verification efforts here first.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border/60">
                  <th className="text-left py-2 px-3 font-medium">
                    Entity Type
                  </th>
                  <th className="text-right py-2 px-3 font-medium">
                    Total
                  </th>
                  <th className="text-right py-2 px-3 font-medium">
                    Indexed
                  </th>
                  <th className="text-right py-2 px-3 font-medium">Gap</th>
                  <th className="text-right py-2 px-3 font-medium">
                    Coverage
                  </th>
                </tr>
              </thead>
              <tbody>
                {priorityTypes.map((row) => (
                  <tr
                    key={row.type}
                    className="border-b border-border/30 hover:bg-muted/30"
                  >
                    <td className="py-2 px-3 font-medium">{row.type}</td>
                    <td className="text-right py-2 px-3 tabular-nums">
                      {row.total}
                    </td>
                    <td className="text-right py-2 px-3 tabular-nums">
                      {row.indexed}
                    </td>
                    <td className="text-right py-2 px-3 tabular-nums text-red-600 font-medium">
                      {row.total - row.indexed}
                    </td>
                    <td
                      className={`text-right py-2 px-3 tabular-nums font-medium ${coverageColor(row.pct)}`}
                    >
                      {row.pct}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Data source footer ─────────────────────────────────────────── */}
      <p className="text-xs text-muted-foreground mt-4">
        Data from{" "}
        <code className="text-[11px]">kb_fact_verdicts</code>,{" "}
        <code className="text-[11px]">record_verdicts</code>, and{" "}
        <code className="text-[11px]">thing_verdicts</code> tables in the
        wiki-server database. Entity counts from local{" "}
        <code className="text-[11px]">database.json</code>.
      </p>
    </>
  );
}
