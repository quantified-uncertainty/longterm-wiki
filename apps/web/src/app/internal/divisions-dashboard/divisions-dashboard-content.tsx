import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
  type RpcDivisionsStatsResult,
  type RpcDivisionsAllResult,
  type RpcDivisionRow,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { getKBEntity } from "@data/kb";
import { DivisionsTable, type DivisionRow } from "./divisions-table";

// ── Types ─────────────────────────────────────────────────────────────────

interface DashboardData {
  stats: RpcDivisionsStatsResult;
  divisions: RpcDivisionRow[];
}

// ── Data Loading ──────────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const [statsResult, allResult] = await Promise.all([
    fetchDetailed<RpcDivisionsStatsResult>("/api/divisions/stats", {
      revalidate: 60,
    }),
    fetchDetailed<RpcDivisionsAllResult>("/api/divisions/all?limit=500", {
      revalidate: 60,
    }),
  ]);

  if (!statsResult.ok) return statsResult;
  if (!allResult.ok) return allResult;

  return {
    ok: true,
    data: {
      stats: statsResult.data,
      divisions: allResult.data.divisions,
    },
  };
}

function emptyFallback(): DashboardData {
  return {
    stats: {
      total: 0,
      byType: { fund: 0, team: 0, department: 0, lab: 0, "program-area": 0 },
      byStatus: { active: 0, inactive: 0, dissolved: 0 },
    },
    divisions: [],
  };
}

// ── Entity name resolution ────────────────────────────────────────────────

function resolveEntityName(stableId: string): string {
  const entity = getKBEntity(stableId);
  return entity?.name ?? stableId;
}

function enrichWithNames(divisions: RpcDivisionRow[]): DivisionRow[] {
  return divisions.map((d) => ({
    ...d,
    parentOrgName: resolveEntityName(d.parentOrgId),
  }));
}

// ── Content Component ────────────────────────────────────────────────────

export async function DivisionsDashboardContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    emptyFallback
  );

  const { stats, divisions } = data;

  const typeEntries = Object.entries(stats.byType).filter(
    ([, v]) => (v as number) > 0
  ) as [string, number][];
  const statusEntries = Object.entries(stats.byStatus).filter(
    ([, v]) => (v as number) > 0
  ) as [string, number][];

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Overview of organizational divisions (funds, teams, labs, departments,
        program areas) synced from structured data sources.
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 my-6">
        <StatCard label="Total Divisions" value={stats.total.toString()} />
        {typeEntries.map(([type, count]) => (
          <StatCard
            key={type}
            label={formatTypeLabel(type)}
            value={count.toString()}
          />
        ))}
      </div>

      {/* By status */}
      {statusEntries.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">By Status</h2>
          <div className="flex gap-4 flex-wrap">
            {statusEntries.map(([status, count]) => (
              <div
                key={status}
                className="rounded-lg border border-border/60 px-4 py-2 flex items-center gap-2"
              >
                <span
                  className={`text-sm font-medium ${statusColor(status)}`}
                >
                  {status}
                </span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {count}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Divisions table */}
      {divisions.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">All Divisions</h2>
          <DivisionsTable data={enrichWithNames(divisions)} />
        </div>
      )}

      {stats.total === 0 && (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground my-6">
          <p className="text-lg font-medium mb-2">No divisions synced yet</p>
          <p className="text-sm">
            Use the divisions sync API to import division data.
          </p>
        </div>
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </>
  );
}

// ── Helper Components ────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function formatTypeLabel(type: string): string {
  switch (type) {
    case "fund":
      return "Funds";
    case "team":
      return "Teams";
    case "department":
      return "Departments";
    case "lab":
      return "Labs";
    case "program-area":
      return "Program Areas";
    default:
      return type;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "active":
      return "text-emerald-600";
    case "inactive":
      return "text-amber-500";
    case "dissolved":
      return "text-red-500";
    default:
      return "text-muted-foreground";
  }
}
