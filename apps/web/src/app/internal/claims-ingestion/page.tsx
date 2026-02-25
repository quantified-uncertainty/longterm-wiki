import { fetchDetailed } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { IngestionTable } from "./ingestion-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Claims Ingestion | Longterm Wiki Internal",
  description:
    "Overview of claims ingestion: resource-sourced vs page-extracted, mode distribution, per-resource breakdown.",
};

interface ClaimRow {
  id: number;
  entityId: string;
  claimType: string;
  claimText: string;
  claimMode: string | null;
  resourceIds: string[] | null;
  section: string | null;
  createdAt: string;
}

interface ClaimStats {
  total: number;
  byClaimType: Record<string, number>;
  byClaimMode: Record<string, number>;
  withSourcesClaims: number;
  attributedClaims: number;
}

export interface ResourceBreakdownRow {
  resourceId: string;
  claimCount: number;
  entityCount: number;
  latestDate: string;
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

function DistributionBar({
  label,
  items,
}: {
  label: string;
  items: { name: string; count: number; color: string }[];
}) {
  const total = items.reduce((s, i) => s + i.count, 0);
  if (total === 0) return null;
  return (
    <div className="space-y-1">
      <div className="text-sm font-medium">{label}</div>
      <div className="flex h-6 rounded-md overflow-hidden">
        {items.map((item) => (
          <div
            key={item.name}
            className={`${item.color} flex items-center justify-center text-[10px] font-medium text-white`}
            style={{ width: `${(item.count / total) * 100}%` }}
            title={`${item.name}: ${item.count}`}
          >
            {item.count > 0 && `${item.name} (${item.count})`}
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function ClaimsIngestionPage() {
  const statsResult = await fetchDetailed<ClaimStats>("/api/claims/stats", {
    revalidate: 60,
  });
  const allResult = await fetchDetailed<{ claims: ClaimRow[] }>(
    "/api/claims/all?limit=5000",
    { revalidate: 60 },
  );

  const stats = statsResult.ok ? statsResult.data : null;
  const claims = allResult.ok ? allResult.data.claims : [];
  const source = statsResult.ok ? ("api" as const) : ("local" as const);
  const apiError = !statsResult.ok ? statsResult.error : undefined;

  // Compute resource breakdown from claims
  const resourceClaims = claims.filter(
    (c) => c.section && c.section.startsWith("Resource:"),
  );
  const pageExtractedClaims = claims.filter(
    (c) => !c.section || !c.section.startsWith("Resource:"),
  );

  // Per-resource breakdown
  const byResource = new Map<
    string,
    { claimCount: number; entities: Set<string>; latest: string }
  >();
  for (const c of resourceClaims) {
    const resId = c.section!.replace("Resource: ", "");
    const entry = byResource.get(resId) || {
      claimCount: 0,
      entities: new Set<string>(),
      latest: "",
    };
    entry.claimCount++;
    entry.entities.add(c.entityId);
    if (c.createdAt > entry.latest) entry.latest = c.createdAt;
    byResource.set(resId, entry);
  }
  const breakdownRows: ResourceBreakdownRow[] = [...byResource.entries()]
    .map(([resourceId, data]) => ({
      resourceId,
      claimCount: data.claimCount,
      entityCount: data.entities.size,
      latestDate: data.latest,
    }))
    .sort((a, b) => b.claimCount - a.claimCount);

  const resourceSourcedCount = resourceClaims.length;
  const pageExtractedCount = pageExtractedClaims.length;

  // Mode counts
  const endorsedCount = stats?.byClaimMode?.endorsed ?? 0;
  const attributedCount = stats?.byClaimMode?.attributed ?? 0;
  const contestedCount = stats?.byClaimMode?.contested ?? 0;
  const noModeCount = Math.max(0, (stats?.total ?? 0) - endorsedCount - attributedCount - contestedCount);

  return (
    <article className="prose max-w-none">
      <h1>Claims Ingestion</h1>
      <p className="text-muted-foreground">
        Overview of the claims ingestion pipeline — resource-sourced vs
        page-extracted claims, mode distribution, and per-resource breakdown.
      </p>

      {/* Stat cards */}
      <div className="not-prose grid grid-cols-2 md:grid-cols-4 gap-4 my-6">
        <StatCard
          label="Total Claims"
          value={stats?.total ?? 0}
        />
        <StatCard
          label="Resource-Sourced"
          value={resourceSourcedCount}
          sub={`${stats?.total ? ((resourceSourcedCount / stats.total) * 100).toFixed(0) : 0}% of total`}
        />
        <StatCard
          label="Page-Extracted"
          value={pageExtractedCount}
        />
        <StatCard
          label="With Sources"
          value={stats?.withSourcesClaims ?? 0}
          sub={`${stats?.total ? ((stats.withSourcesClaims / stats.total) * 100).toFixed(0) : 0}% linked`}
        />
      </div>

      {/* Distribution bars */}
      <div className="not-prose space-y-4 my-6">
        <DistributionBar
          label="Source Distribution"
          items={[
            {
              name: "Resource",
              count: resourceSourcedCount,
              color: "bg-blue-500",
            },
            {
              name: "Page",
              count: pageExtractedCount,
              color: "bg-emerald-500",
            },
          ]}
        />
        <DistributionBar
          label="Claim Mode"
          items={[
            { name: "Endorsed", count: endorsedCount, color: "bg-emerald-600" },
            { name: "Attributed", count: attributedCount, color: "bg-blue-500" },
            { name: "Contested", count: contestedCount, color: "bg-amber-500" },
            { name: "Unset", count: noModeCount, color: "bg-gray-400" },
          ]}
        />
      </div>

      {/* Per-resource table */}
      <h2>Per-Resource Breakdown</h2>
      {breakdownRows.length === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground not-prose">
          <p className="text-lg font-medium mb-2">No resource-sourced claims</p>
          <p className="text-sm">
            Run{" "}
            <code className="text-xs">
              pnpm crux claims from-resource &lt;url&gt;
            </code>{" "}
            or{" "}
            <code className="text-xs">
              pnpm crux claims ingest-resource &lt;id&gt;
            </code>{" "}
            to ingest claims from external resources.
          </p>
        </div>
      ) : (
        <IngestionTable data={breakdownRows} />
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </article>
  );
}
