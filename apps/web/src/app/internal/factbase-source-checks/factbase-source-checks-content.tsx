import {
  fetchDetailed,
  type FetchResult,
  type RpcSourceChecksStatsResult,
  type RpcSourceChecksVerdictsResult,
  type RpcSourceCheckVerdictRow,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { FactBaseSourceChecksTable } from "./factbase-source-checks-table";

// Re-export the RPC-inferred types for the table component
export type VerdictRow = RpcSourceCheckVerdictRow;

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadStats(): Promise<FetchResult<RpcSourceChecksStatsResult>> {
  return fetchDetailed<RpcSourceChecksStatsResult>("/api/verifications/stats");
}

async function loadAllVerdicts(): Promise<FetchResult<RpcSourceChecksVerdictsResult>> {
  // Paginate through all fact verdicts in batches of 200 (server max page size)
  const PAGE_SIZE = 200;
  let offset = 0;
  let allVerdicts: RpcSourceCheckVerdictRow[] = [];
  let total = 0;

  while (true) {
    const result = await fetchDetailed<RpcSourceChecksVerdictsResult>(
      `/api/verifications/verdicts?record_type=fact&limit=${PAGE_SIZE}&offset=${offset}`
    );
    if (!result.ok) return result;

    const page = result.data.verdicts ?? [];
    allVerdicts = [...allVerdicts, ...page];
    const reportedTotal = result.data.total;
    total = reportedTotal ?? allVerdicts.length;
    if (
      (reportedTotal != null && allVerdicts.length >= reportedTotal) ||
      page.length < PAGE_SIZE
    ) {
      break;
    }
    offset += PAGE_SIZE;
  }

  return { ok: true as const, data: { verdicts: allVerdicts, total } };
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${color || ""}`}>
        {value}
      </div>
    </div>
  );
}

// ── Verdict badge colors ──────────────────────────────────────────────────────

const VERDICT_COLORS: Record<string, string> = {
  confirmed: "text-emerald-600",
  contradicted: "text-red-600",
  outdated: "text-amber-600",
  partial: "text-amber-500",
  unverifiable: "text-muted-foreground",
  unchecked: "text-muted-foreground",
};

// ── Bar colors ────────────────────────────────────────────────────────────────

const BAR_COLORS: Record<string, string> = {
  confirmed: "bg-emerald-500",
  contradicted: "bg-red-500",
  outdated: "bg-amber-500",
  partial: "bg-amber-400",
  unverifiable: "bg-gray-400",
  unchecked: "bg-gray-300",
};

// ── Main content component ────────────────────────────────────────────────────

export async function FactBaseSourceChecksContent() {
  const [statsResult, verdictsResult] = await Promise.all([
    loadStats(),
    loadAllVerdicts(),
  ]);

  const hasApi = statsResult.ok && verdictsResult.ok;
  const apiError = !statsResult.ok
    ? statsResult.error
    : !verdictsResult.ok
      ? verdictsResult.error
      : undefined;

  if (!hasApi) {
    return (
      <>
        <p className="text-muted-foreground">
          FactBase Source-Check dashboard requires a connection to the
          wiki-server. No local fallback is available for this data.
        </p>
        <DataSourceBanner source="local" apiError={apiError} />
      </>
    );
  }

  const stats = statsResult.data;
  const verdicts = verdictsResult.data.verdicts;

  const verdictEntries = Object.entries(stats.by_verdict).sort(
    ([, a], [, b]) => b - a
  );

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Source-check status for FactBase facts checked against external resources.{" "}
        <span className="font-medium text-foreground">
          {stats.total}
        </span>{" "}
        facts have verdicts.
        {stats.needs_recheck > 0 && (
          <span className="text-amber-500 font-medium">
            {" "}
            {stats.needs_recheck} need rechecking.
          </span>
        )}
      </p>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 not-prose mb-6">
        <StatCard label="Total Checked" value={stats.total} />
        <StatCard
          label="Avg Confidence"
          value={`${Math.round(stats.avg_confidence * 100)}%`}
        />
        <StatCard
          label="Needs Recheck"
          value={stats.needs_recheck}
          color={stats.needs_recheck > 0 ? "text-amber-600" : ""}
        />
        <StatCard
          label="Confirmed"
          value={stats.by_verdict["confirmed"] ?? 0}
          color="text-emerald-600"
        />
      </div>

      {/* Verdict distribution */}
      {verdictEntries.length > 0 && (
        <div className="not-prose mb-6">
          <h3 className="text-sm font-semibold mb-3">Verdict Distribution</h3>
          <div className="flex gap-2 flex-wrap">
            {verdictEntries.map(([verdict, verdictCount]) => (
              <span
                key={verdict}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium bg-muted ${VERDICT_COLORS[verdict] || "text-muted-foreground"}`}
              >
                {verdict}
                <span className="tabular-nums font-semibold">
                  {verdictCount}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Distribution bar */}
      {stats.total > 0 && verdictEntries.length > 0 && (
        <div className="not-prose mb-6">
          <div className="flex rounded-full overflow-hidden h-4">
            {verdictEntries.map(([verdict, verdictCount]) => (
              <div
                key={verdict}
                className={BAR_COLORS[verdict] || "bg-gray-300"}
                style={{
                  width: `${(verdictCount / stats.total) * 100}%`,
                }}
                title={`${verdict}: ${verdictCount}`}
              />
            ))}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground mt-1 flex-wrap gap-x-4">
            {verdictEntries.map(([verdict, verdictCount]) => (
              <span key={verdict}>
                {verdict}:{" "}
                {Math.round((verdictCount / stats.total) * 100)}%
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Interactive table */}
      <FactBaseSourceChecksTable data={verdicts} />

      <DataSourceBanner source="api" />
      <p className="text-xs text-muted-foreground mt-1">
        Data from <code className="text-[11px]">source_check_verdicts</code> and{" "}
        <code className="text-[11px]">source_check_evidence</code>{" "}
        tables in the wiki-server database.
      </p>
    </>
  );
}
