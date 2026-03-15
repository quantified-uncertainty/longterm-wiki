import {
  fetchDetailed,
  type FetchResult,
  type RpcKbStatsResult,
  type RpcKbVerdictsResult,
  type RpcKbVerdictRow,
  type RpcKbVerdictDetailResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { FactBaseVerificationsTable } from "./factbase-verifications-table";

// Re-export the RPC-inferred types for the table component
export type VerdictRow = RpcKbVerdictRow;
export type VerdictDetailResult = RpcKbVerdictDetailResult;

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadStats(): Promise<FetchResult<RpcKbStatsResult>> {
  return fetchDetailed<RpcKbStatsResult>("/api/kb-verifications/stats");
}

async function loadVerdicts(): Promise<FetchResult<RpcKbVerdictsResult>> {
  return fetchDetailed<RpcKbVerdictsResult>(
    "/api/kb-verifications/verdicts?limit=200"
  );
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

export async function FactBaseVerificationsContent() {
  const [statsResult, verdictsResult] = await Promise.all([
    loadStats(),
    loadVerdicts(),
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
          FactBase Verification dashboard requires a connection to the
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
        Verification status for FactBase facts checked against external resources.{" "}
        <span className="font-medium text-foreground">
          {stats.total_facts}
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
        <StatCard label="Total Checked" value={stats.total_facts} />
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
      {stats.total_facts > 0 && verdictEntries.length > 0 && (
        <div className="not-prose mb-6">
          <div className="flex rounded-full overflow-hidden h-4">
            {verdictEntries.map(([verdict, verdictCount]) => (
              <div
                key={verdict}
                className={BAR_COLORS[verdict] || "bg-gray-300"}
                style={{
                  width: `${(verdictCount / stats.total_facts) * 100}%`,
                }}
                title={`${verdict}: ${verdictCount}`}
              />
            ))}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground mt-1 flex-wrap gap-x-4">
            {verdictEntries.map(([verdict, verdictCount]) => (
              <span key={verdict}>
                {verdict}:{" "}
                {Math.round((verdictCount / stats.total_facts) * 100)}%
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Interactive table */}
      <FactBaseVerificationsTable data={verdicts} />

      <DataSourceBanner source="api" />
      <p className="text-xs text-muted-foreground mt-1">
        Data from <code className="text-[11px]">kb_fact_verdicts</code> and{" "}
        <code className="text-[11px]">kb_fact_resource_verifications</code>{" "}
        tables in the wiki-server database.
      </p>
    </>
  );
}
