import type { Metadata } from "next";
import Link from "next/link";
import { fetchFromWikiServer } from "@lib/wiki-server";
import type { ClaimStatsResult } from "@wiki-server/api-response-types";
import { StatCard } from "./components/stat-card";
import { DistributionBar } from "./components/distribution-bar";
import {
  fetchAllClaims,
  collectEntitySlugs,
  buildEntityNameMap,
} from "./components/claims-data";

// Skip static generation — fetches all claims from wiki-server which is
// too heavy to run during build alongside hundreds of other API requests.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Claims Explorer",
  description:
    "Browse extracted claims across all wiki pages: categories, relationships, and verification status.",
};

export default async function ClaimsOverviewPage() {
  const [stats, claims] = await Promise.all([
    fetchFromWikiServer<ClaimStatsResult>("/api/claims/stats", {
      revalidate: 300,
    }),
    fetchAllClaims(),
  ]);

  if (!stats) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-2">Claims Explorer</h1>
        <p className="text-muted-foreground">
          Wiki-server unavailable. Set <code>LONGTERMWIKI_SERVER_URL</code> to
          enable.
        </p>
      </div>
    );
  }

  // Build per-entity breakdown
  const entityMap = new Map<
    string,
    {
      total: number;
      verified: number;
      multiEntity: number;
    }
  >();
  for (const claim of claims) {
    const eid = claim.entityId;
    if (!entityMap.has(eid)) {
      entityMap.set(eid, { total: 0, verified: 0, multiEntity: 0 });
    }
    const entry = entityMap.get(eid)!;
    entry.total++;
    if (claim.confidence === "verified") entry.verified++;
    if (claim.relatedEntities && claim.relatedEntities.length > 0)
      entry.multiEntity++;
  }

  const entityRows = [...entityMap.entries()]
    .map(([entityId, data]) => ({ entityId, ...data }))
    .sort((a, b) => b.total - a.total);

  // Build entity name map for display
  const entityNames = buildEntityNameMap(collectEntitySlugs(claims));

  // Build relationship counts (skip self-referential).
  // relatedEntities are already normalized (lowercased) by the server.
  const pairCounts = new Map<
    string,
    { from: string; to: string; count: number; sample: string }
  >();
  for (const claim of claims) {
    if (!claim.relatedEntities || claim.relatedEntities.length === 0) continue;
    for (const related of claim.relatedEntities) {
      if (related === claim.entityId) continue;
      const [a, b] = [claim.entityId, related].sort();
      const pair = `${a} <-> ${b}`;
      if (!pairCounts.has(pair)) {
        pairCounts.set(pair, {
          from: a,
          to: b,
          count: 0,
          sample: claim.claimText.slice(0, 80),
        });
      }
      pairCounts.get(pair)!.count++;
    }
  }

  const relationshipRows = [...pairCounts.values()].sort(
    (a, b) => b.count - a.count
  );

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Claims Explorer</h1>
      <p className="text-muted-foreground mb-6">
        Extracted claims across all wiki pages.{" "}
        <span className="font-medium text-foreground">
          {stats.total.toLocaleString()}
        </span>{" "}
        total claims from{" "}
        <span className="font-medium text-foreground">
          {entityRows.length}
        </span>{" "}
        entities.
      </p>

      {/* Global stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-8">
        <StatCard label="Total Claims" value={stats.total} />
        <StatCard label="Entities" value={entityRows.length} />
        <StatCard label="Multi-Entity" value={stats.multiEntityClaims} />
        {stats.factLinkedClaims > 0 && (
          <StatCard label="Fact-Linked" value={stats.factLinkedClaims} />
        )}
        <StatCard label="Relationships" value={relationshipRows.length} />
        {(stats.numericClaims ?? 0) > 0 && (
          <StatCard label="Numeric" value={stats.numericClaims ?? 0} />
        )}
      </div>

      {/* Category distribution */}
      <div className="rounded-lg border p-4 mb-6">
        <h3 className="text-sm font-semibold mb-3">Claim Categories</h3>
        <DistributionBar
          data={stats.byClaimCategory}
          total={stats.total}
        />
      </div>

      {/* Type distribution */}
      <div className="rounded-lg border p-4 mb-6">
        <h3 className="text-sm font-semibold mb-3">Claim Types</h3>
        <DistributionBar data={stats.byClaimType} total={stats.total} />
      </div>

      {/* Mode distribution (Phase 2) */}
      {stats.byClaimMode && Object.keys(stats.byClaimMode).length > 0 && (
        <div className="rounded-lg border p-4 mb-6">
          <h3 className="text-sm font-semibold mb-3">Epistemic Mode</h3>
          <DistributionBar data={stats.byClaimMode} total={stats.total} />
          <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
            {stats.attributedClaims !== undefined && (
              <span>
                <span className="font-medium text-amber-700">
                  {stats.attributedClaims}
                </span>{" "}
                attributed (reported speech)
              </span>
            )}
            {stats.withSourcesClaims !== undefined && (
              <span>
                <span className="font-medium text-blue-700">
                  {stats.withSourcesClaims}
                </span>{" "}
                with structured sources
              </span>
            )}
          </div>
        </div>
      )}

      {/* Top entities */}
      {entityRows.length > 0 && (
        <div className="rounded-lg border p-4 mb-6">
          <h3 className="text-sm font-semibold mb-3">Top Entities by Claims</h3>
          <div className="space-y-2">
            {entityRows.slice(0, 10).map((row) => (
                <div key={row.entityId} className="flex items-center gap-3">
                  <Link
                    href={`/claims/entity/${row.entityId}`}
                    className="text-sm text-blue-600 hover:underline w-40 truncate"
                  >
                    {entityNames[row.entityId] ?? row.entityId}
                  </Link>
                  <div className="flex-1 flex items-center gap-2">
                    <div className="flex-1 h-4 bg-gray-100 rounded overflow-hidden">
                      <div
                        className="h-full bg-blue-400 rounded-l"
                        style={{
                          width: `${(row.total / entityRows[0].total) * 100}%`,
                        }}
                      />
                    </div>
                    <span className="text-xs tabular-nums w-8 text-right">
                      {row.total}
                    </span>
                  </div>
                  {row.multiEntity > 0 && (
                    <span className="text-[10px] text-teal-600 whitespace-nowrap">
                      {row.multiEntity} linked
                    </span>
                  )}
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* Top relationships */}
      {relationshipRows.length > 0 && (
        <div className="rounded-lg border p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Top Entity Relationships</h3>
            <Link
              href="/claims/relationships"
              className="text-xs text-blue-600 hover:underline"
            >
              View all
            </Link>
          </div>
          <div className="space-y-1.5">
            {relationshipRows.slice(0, 15).map((rel, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <Link
                  href={`/claims/entity/${rel.from}`}
                  className="text-blue-600 hover:underline text-xs"
                >
                  {entityNames[rel.from] ?? rel.from}
                </Link>
                <span className="text-muted-foreground text-xs">
                  &harr;
                </span>
                <Link
                  href={`/claims/entity/${rel.to}`}
                  className="text-blue-600 hover:underline text-xs"
                >
                  {entityNames[rel.to] ?? rel.to}
                </Link>
                <span className="tabular-nums font-medium text-xs ml-auto">
                  {rel.count}
                </span>
                <span className="text-[10px] text-muted-foreground truncate max-w-[300px]">
                  {rel.sample}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
