import type { Metadata } from "next";
import Link from "next/link";
import {
  fetchDetailed,
  type RpcFundingProgramsStatsResult,
  type RpcFundingProgramsAllResult,
  type RpcFundingProgramRow,
} from "@lib/wiki-server";
import { getKBEntity, getKBEntitySlug } from "@/data/kb";
import { ProfileStatCard } from "@/components/directory";
import { formatCompactCurrency } from "@/lib/format-compact";
import {
  FundingProgramsListTable,
  type FundingProgramListRow,
} from "./funding-programs-table";
import { PROGRAM_TYPE_LABELS } from "./funding-programs-constants";

export const metadata: Metadata = {
  title: "Funding Programs",
  description:
    "Directory of funding programs across AI safety and related organizations, including RFPs, grant rounds, fellowships, and prizes.",
};

/** ISR revalidation: refresh every 5 minutes */
export const revalidate = 300;

/**
 * Resolve an org entity ID to its display name and slug for linking.
 */
function resolveOrg(orgId: string): {
  name: string;
  slug: string | null;
} {
  const entity = getKBEntity(orgId);
  if (entity) {
    const slug = getKBEntitySlug(orgId) ?? null;
    return { name: entity.name, slug };
  }
  return { name: orgId, slug: null };
}

/**
 * Enrich raw API rows with resolved organization names and slugs.
 */
function enrichRows(programs: RpcFundingProgramRow[]): FundingProgramListRow[] {
  return programs.map((p) => {
    const org = resolveOrg(p.orgId);
    return {
      id: p.id,
      name: p.name,
      orgId: p.orgId,
      orgName: org.name,
      orgSlug: org.slug,
      divisionId: p.divisionId,
      programType: p.programType,
      totalBudget: p.totalBudget,
      currency: p.currency ?? "USD",
      applicationUrl: p.applicationUrl,
      openDate: p.openDate,
      deadline: p.deadline,
      status: p.status,
      source: p.source,
      description: p.description,
    };
  });
}

export default async function FundingProgramsPage() {
  // Fetch stats and full program list from wiki-server in parallel
  const [statsResult, allResult] = await Promise.all([
    fetchDetailed<RpcFundingProgramsStatsResult>(
      "/api/funding-programs/stats",
      { revalidate: 300 },
    ),
    fetchDetailed<RpcFundingProgramsAllResult>(
      "/api/funding-programs/all?limit=500",
      { revalidate: 300 },
    ),
  ]);

  const stats = statsResult.ok ? statsResult.data : null;
  const programs = allResult.ok ? allResult.data.fundingPrograms : [];
  const rows = enrichRows(programs);

  // Compute summary stats
  const totalPrograms = stats?.total ?? rows.length;
  const totalBudget =
    stats?.totalBudget ??
    rows.reduce((sum, r) => sum + (r.totalBudget ?? 0), 0);
  const uniqueOrgs = new Set(rows.map((r) => r.orgId)).size;
  const openCount =
    stats?.byStatus.open ??
    rows.filter((r) => r.status === "open").length;

  // Build org summary (sorted by total budget desc)
  const orgTotals = new Map<
    string,
    {
      id: string;
      name: string;
      count: number;
      totalBudget: number;
      slug: string | null;
    }
  >();
  for (const r of rows) {
    const existing = orgTotals.get(r.orgId);
    if (existing) {
      existing.count += 1;
      existing.totalBudget += r.totalBudget ?? 0;
    } else {
      orgTotals.set(r.orgId, {
        id: r.orgId,
        name: r.orgName,
        count: 1,
        totalBudget: r.totalBudget ?? 0,
        slug: r.orgSlug,
      });
    }
  }
  const topOrgs = [...orgTotals.values()].sort(
    (a, b) => b.totalBudget - a.totalBudget,
  );

  // Build type summary
  const typeSummary: { type: string; label: string; count: number }[] = [];
  if (stats) {
    for (const [type, count] of Object.entries(stats.byType)) {
      if ((count as number) > 0) {
        typeSummary.push({
          type,
          label: PROGRAM_TYPE_LABELS[type] ?? type,
          count: count as number,
        });
      }
    }
  } else {
    const typeCounts = new Map<string, number>();
    for (const r of rows) {
      typeCounts.set(r.programType, (typeCounts.get(r.programType) ?? 0) + 1);
    }
    for (const [type, count] of typeCounts) {
      typeSummary.push({
        type,
        label: PROGRAM_TYPE_LABELS[type] ?? type,
        count,
      });
    }
  }
  typeSummary.sort((a, b) => b.count - a.count);

  const summaryStats = [
    { label: "Total Programs", value: totalPrograms.toLocaleString() },
    { label: "Total Budget", value: formatCompactCurrency(totalBudget) },
    { label: "Organizations", value: String(uniqueOrgs) },
    { label: "Currently Open", value: String(openCount) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Funding Programs
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of funding opportunities across AI safety and related
          organizations, including RFPs, grant rounds, fellowships, prizes, and
          open calls for proposals.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {summaryStats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      {/* By type summary */}
      {typeSummary.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">By Type</h2>
          <div className="flex gap-3 flex-wrap">
            {typeSummary.map((t) => (
              <div
                key={t.type}
                className="rounded-lg border border-border/60 px-4 py-2 flex items-center gap-2"
              >
                <span className="text-sm font-medium text-foreground">
                  {t.label}
                </span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {t.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* By organization summary */}
      {topOrgs.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">By Organization</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {topOrgs.map((org) => (
              <div
                key={org.id}
                className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {org.slug ? (
                      <Link
                        href={`/organizations/${org.slug}`}
                        className="hover:underline"
                      >
                        {org.name}
                      </Link>
                    ) : (
                      org.name
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {org.count} program{org.count !== 1 ? "s" : ""}
                  </p>
                </div>
                <p className="text-sm font-semibold tabular-nums">
                  {formatCompactCurrency(org.totalBudget)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Programs table */}
      {rows.length > 0 ? (
        <FundingProgramsListTable rows={rows} />
      ) : (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">
            No funding programs available
          </p>
          <p className="text-sm">
            Funding program data is loaded from the wiki-server API. Check that
            the server is configured and reachable.
          </p>
        </div>
      )}
    </div>
  );
}
