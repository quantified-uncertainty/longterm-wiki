import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
  type RpcGrantsStatsResult,
  type RpcGrantsAllResult,
  type RpcGrantsOrgSummaryResult,
  type RpcGrantsGranteeSummaryResult,
  type RpcGrantRow,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { getKBEntity } from "@data/kb";
import { GrantsTable, type GrantRow } from "./grants-table";

// ── Types ─────────────────────────────────────────────────────────────────

type OrgSummaryRow = RpcGrantsOrgSummaryResult["organizations"][number];
type GranteeSummaryRow = RpcGrantsGranteeSummaryResult["grantees"][number];

interface DashboardData {
  stats: RpcGrantsStatsResult;
  orgSummary: OrgSummaryRow[];
  granteeSummary: GranteeSummaryRow[];
  recentGrants: RpcGrantRow[];
}

// ── Data Loading ──────────────────────────────────────────────────────────

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const [statsResult, orgResult, granteeResult, grantsResult] =
    await Promise.all([
      fetchDetailed<RpcGrantsStatsResult>("/api/grants/stats", { revalidate: 60 }),
      fetchDetailed<RpcGrantsOrgSummaryResult>("/api/grants/by-org-summary", {
        revalidate: 60,
      }),
      fetchDetailed<RpcGrantsGranteeSummaryResult>("/api/grants/by-grantee-summary", {
        revalidate: 60,
      }),
      fetchDetailed<RpcGrantsAllResult>("/api/grants/all?limit=50", {
        revalidate: 60,
      }),
    ]);

  if (!statsResult.ok) return statsResult;
  if (!orgResult.ok) return orgResult;
  if (!granteeResult.ok) return granteeResult;
  if (!grantsResult.ok) return grantsResult;

  return {
    ok: true,
    data: {
      stats: statsResult.data,
      orgSummary: orgResult.data.organizations,
      granteeSummary: granteeResult.data.grantees,
      recentGrants: grantsResult.data.grants,
    },
  };
}

function emptyFallback(): DashboardData {
  return {
    stats: { total: 0, totalAmount: 0, uniqueOrganizations: 0 },
    orgSummary: [],
    granteeSummary: [],
    recentGrants: [],
  };
}

// ── Entity name resolution ────────────────────────────────────────────────

/** Resolve an entity stableId to a display name via the KB data layer. */
function resolveEntityName(stableId: string): string {
  const entity = getKBEntity(stableId);
  return entity?.name ?? stableId;
}

/** Enrich grant rows with resolved organization names for the client table. */
function enrichWithNames(grants: RpcGrantRow[]): GrantRow[] {
  return grants.map((g) => ({
    ...g,
    organizationName: resolveEntityName(g.organizationId),
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

export async function GrantsDashboardContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    emptyFallback
  );

  const { stats, orgSummary, granteeSummary, recentGrants } = data;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Overview of grants imported from external sources (Coefficient Giving,
        EA Funds, SFF, FTX, Manifund). Data is synced from CSV imports via the
        grant import pipeline.
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 my-6">
        <StatCard label="Total Grants" value={stats.total.toLocaleString()} />
        <StatCard label="Total Funding" value={formatUSD(stats.totalAmount)} />
        <StatCard
          label="Funding Orgs"
          value={stats.uniqueOrganizations.toString()}
        />
        <StatCard
          label="Grantees Matched"
          value={granteeSummary.length.toString()}
        />
      </div>

      {/* By funder */}
      {orgSummary.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">By Funder</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 pr-4 font-medium text-muted-foreground">
                    Organization
                  </th>
                  <th className="text-right py-2 px-4 font-medium text-muted-foreground">
                    Grants
                  </th>
                  <th className="text-right py-2 px-4 font-medium text-muted-foreground">
                    Total Amount
                  </th>
                  <th className="text-right py-2 px-4 font-medium text-muted-foreground">
                    Date Range
                  </th>
                </tr>
              </thead>
              <tbody>
                {orgSummary.map((org) => (
                  <tr
                    key={org.organizationId}
                    className="border-b border-border/50"
                  >
                    <td className="py-2 pr-4 text-foreground font-medium">
                      {resolveEntityName(org.organizationId)}
                    </td>
                    <td className="py-2 px-4 text-right tabular-nums text-muted-foreground">
                      {org.grantCount.toLocaleString()}
                    </td>
                    <td className="py-2 px-4 text-right tabular-nums font-medium">
                      {formatUSD(org.totalAmount)}
                    </td>
                    <td className="py-2 px-4 text-right text-xs text-muted-foreground">
                      {org.minDate && org.maxDate
                        ? `${org.minDate} - ${org.maxDate}`
                        : org.minDate || org.maxDate || "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Top grantees */}
      {granteeSummary.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">
            Top Funded Organizations (Grantees)
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 pr-4 font-medium text-muted-foreground">
                    Grantee
                  </th>
                  <th className="text-right py-2 px-4 font-medium text-muted-foreground">
                    Grants
                  </th>
                  <th className="text-right py-2 px-4 font-medium text-muted-foreground">
                    Total Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {granteeSummary.slice(0, 20).map((g) => (
                  <tr
                    key={g.granteeId ?? "unknown"}
                    className="border-b border-border/50"
                  >
                    <td className="py-2 pr-4 text-foreground font-medium">
                      {g.granteeId ?? "(unknown)"}
                    </td>
                    <td className="py-2 px-4 text-right tabular-nums text-muted-foreground">
                      {g.grantCount.toLocaleString()}
                    </td>
                    <td className="py-2 px-4 text-right tabular-nums font-medium">
                      {formatUSD(g.totalAmount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {granteeSummary.length > 20 && (
              <p className="text-xs text-muted-foreground mt-2">
                Showing top 20 of {granteeSummary.length} grantees
              </p>
            )}
          </div>
        </div>
      )}

      {/* Recent grants table */}
      {recentGrants.length > 0 && (
        <div className="my-6">
          <h2 className="text-lg font-semibold mb-3">Recent Grants</h2>
          <GrantsTable data={enrichWithNames(recentGrants)} />
        </div>
      )}

      {stats.total === 0 && (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground my-6">
          <p className="text-lg font-medium mb-2">No grants imported yet</p>
          <p className="text-sm">
            Use the grant import pipeline to sync grants from external sources.
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
