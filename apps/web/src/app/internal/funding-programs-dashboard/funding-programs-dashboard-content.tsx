import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
  type RpcFundingProgramsStatsResult,
  type RpcFundingProgramsAllResult,
  type RpcFundingProgramRow,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { getKBEntity } from "@data/kb";
import {
  FundingProgramsTable,
  type FundingProgramRow,
} from "./funding-programs-table";

// ── Types ─────────────────────────────────────────────────────────────────

interface DashboardData {
  stats: RpcFundingProgramsStatsResult;
  programs: RpcFundingProgramRow[];
}

// ── Data Loading ──────────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const [statsResult, allResult] = await Promise.all([
    fetchDetailed<RpcFundingProgramsStatsResult>(
      "/api/funding-programs/stats",
      { revalidate: 60 }
    ),
    fetchDetailed<RpcFundingProgramsAllResult>(
      "/api/funding-programs/all?limit=200",
      { revalidate: 60 }
    ),
  ]);

  if (!statsResult.ok) return statsResult;
  if (!allResult.ok) return allResult;

  return {
    ok: true,
    data: {
      stats: statsResult.data,
      programs: allResult.data.fundingPrograms,
    },
  };
}

function emptyFallback(): DashboardData {
  return {
    stats: {
      total: 0,
      totalBudget: 0,
      byType: {
        rfp: 0,
        "grant-round": 0,
        fellowship: 0,
        prize: 0,
        solicitation: 0,
        call: 0,
      },
      byStatus: { open: 0, closed: 0, awarded: 0 },
    },
    programs: [],
  };
}

// ── Entity name resolution ────────────────────────────────────────────────

function resolveEntityName(stableId: string): string {
  const entity = getKBEntity(stableId);
  return entity?.name ?? stableId;
}

function enrichWithNames(
  programs: RpcFundingProgramRow[]
): FundingProgramRow[] {
  return programs.map((p) => ({
    ...p,
    orgName: resolveEntityName(p.orgId),
    currency: p.currency ?? "USD",
  }));
}

// ── Formatting ────────────────────────────────────────────────────────────

function formatUSD(amount: number): string {
  if (amount >= 1_000_000_000)
    return `\$${(amount / 1_000_000_000).toFixed(2)}B`;
  if (amount >= 1_000_000) return `\$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `\$${(amount / 1_000).toFixed(0)}K`;
  return `\$${amount.toLocaleString()}`;
}

// ── Content Component ────────────────────────────────────────────────────

export async function FundingProgramsDashboardContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    emptyFallback
  );

  const { stats, programs } = data;

  const typeEntries = Object.entries(stats.byType).filter(
    ([, v]) => (v as number) > 0
  ) as [string, number][];
  const statusEntries = Object.entries(stats.byStatus).filter(
    ([, v]) => (v as number) > 0
  ) as [string, number][];

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Overview of funding programs (RFPs, grant rounds, fellowships, prizes)
        synced from structured data sources.
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 my-6">
        <StatCard label="Total Programs" value={stats.total.toString()} />
        <StatCard label="Total Budget" value={formatUSD(stats.totalBudget)} />
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

      {/* Programs table */}
      {programs.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">All Programs</h2>
          <FundingProgramsTable data={enrichWithNames(programs)} />
        </div>
      )}

      {stats.total === 0 && (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground my-6">
          <p className="text-lg font-medium mb-2">
            No funding programs synced yet
          </p>
          <p className="text-sm">
            Use the funding programs sync API to import program data.
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
    case "rfp":
      return "RFPs";
    case "grant-round":
      return "Grant Rounds";
    case "fellowship":
      return "Fellowships";
    case "prize":
      return "Prizes";
    case "solicitation":
      return "Solicitations";
    case "call":
      return "Calls";
    default:
      return type;
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "open":
      return "text-emerald-600";
    case "closed":
      return "text-red-500";
    case "awarded":
      return "text-blue-500";
    default:
      return "text-muted-foreground";
  }
}
