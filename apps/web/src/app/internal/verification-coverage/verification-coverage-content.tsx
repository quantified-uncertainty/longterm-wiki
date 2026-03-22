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
  byEntityType: Record<string, number>;
}

/** Stats shape returned by GET /api/verifications/stats (unified) */
interface UnifiedVerificationStatsResult {
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

async function loadThingsStats(): Promise<FetchResult<ThingsStatsResult>> {
  return fetchDetailed<ThingsStatsResult>("/api/things/stats", {
    revalidate: 60,
  });
}

async function loadVerificationStats(): Promise<FetchResult<UnifiedVerificationStatsResult>> {
  return fetchDetailed<UnifiedVerificationStatsResult>("/api/verifications/stats", {
    revalidate: 60,
  });
}

function emptyThingsStats(): ThingsStatsResult {
  return { total: 0, byType: {}, byEntityType: {} };
}

function emptyVerificationStats(): UnifiedVerificationStatsResult {
  return {
    total: 0,
    avg_confidence: 0,
    needs_recheck: 0,
    by_verdict: {},
    by_type: {},
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

// ── Verdict Breakdown Card ────────────────────────────────────────────────

function VerdictBreakdownCard({
  title,
  subtitle,
  verdicts,
}: {
  title: string;
  subtitle: string;
  verdicts: Record<string, number>;
}) {
  const entries = Object.entries(verdicts).sort(([, a], [, b]) => b - a);
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      <p className="text-xs text-muted-foreground mb-2">{subtitle}</p>
      {entries.length > 0 ? (
        <div className="space-y-1">
          {entries.map(([verdict, count]) => (
            <div key={verdict} className="flex justify-between text-xs">
              <span className={VERDICT_COLORS[verdict] || "text-muted-foreground"}>
                {verdict}
              </span>
              <span className="tabular-nums">{count}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No verdicts recorded</p>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────

export async function VerificationCoverageContent() {
  // Load data sources in parallel
  const [thingsResult, verificationResult] = await Promise.all([
    withApiFallback(loadThingsStats, emptyThingsStats),
    withApiFallback(loadVerificationStats, emptyVerificationStats),
  ]);

  // Merge with defaults to guard against undefined fields from unavailable API
  const thingsStats = { ...emptyThingsStats(), ...thingsResult.data };
  const vStats = { ...emptyVerificationStats(), ...verificationResult.data };

  // Determine overall source and error
  const source = thingsResult.source === "api" ? "api" as const : "local" as const;
  const apiError =
    thingsResult.apiError || verificationResult.apiError;

  // Local entity data for coverage by type
  const entities = getTypedEntities();
  const entityCountByType = new Map<string, number>();
  for (const e of entities) {
    const t = e.entityType;
    entityCountByType.set(t, (entityCountByType.get(t) ?? 0) + 1);
  }
  const totalEntities = entities.length;

  // Verdict distribution from unified verification system
  const verdictEntries = Object.entries(vStats.by_verdict ?? {}).sort(
    ([, a], [, b]) => b - a
  );
  const totalVerdicts = verdictEntries.reduce((s, [, c]) => s + c, 0);

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

  // Priority entities — sorted by most entities without coverage
  const priorityTypes = coverageByType
    .filter((c) => c.pct < 100 && c.total > 0)
    .sort((a, b) => b.total - b.indexed - (a.total - a.indexed))
    .slice(0, 10);

  // Pre-compute totals used in footer (avoid repeating reduce in JSX)
  const totalIndexed = coverageByType.reduce((s, r) => s + r.indexed, 0);
  const totalNotIndexed = totalEntities - totalIndexed;
  const totalPct = totalEntities > 0 ? Math.round((totalIndexed / totalEntities) * 100) : 0;

  return (
    <>
      <DataSourceBanner source={source} apiError={apiError} />

      <p className="text-muted-foreground text-sm leading-relaxed mb-6">
        Verification coverage across all record types. Data from the unified{" "}
        <code className="text-[11px]">verification_verdicts</code> and{" "}
        <code className="text-[11px]">verification_evidence</code> tables.
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
                  {totalIndexed}
                </td>
                <td className="text-right py-2 px-3 tabular-nums text-muted-foreground">
                  {totalNotIndexed}
                </td>
                <td
                  className={`text-right py-2 px-3 tabular-nums font-medium ${coverageColor(totalPct)}`}
                >
                  {totalPct}%
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
            All verdicts from the unified verification system.
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

          {/* Per-type breakdown */}
          {Object.keys(vStats.by_type ?? {}).length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
              {Object.entries(vStats.by_type).sort(([,a],[,b]) => b - a).map(([type, count]) => (
                <VerdictBreakdownCard
                  key={type}
                  title={`${type} verdicts`}
                  subtitle={`${count} verdicts`}
                  verdicts={{}}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Staleness and per-record-type coverage sections removed — the unified
          verification system will add these back with richer breakdowns. */}

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
        <code className="text-[11px]">verification_verdicts</code> and{" "}
        <code className="text-[11px]">verification_evidence</code> tables in the
        wiki-server database. Entity counts from local{" "}
        <code className="text-[11px]">database.json</code>.
      </p>
    </>
  );
}
