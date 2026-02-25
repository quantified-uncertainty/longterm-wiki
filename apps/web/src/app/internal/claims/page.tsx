import type { Metadata } from "next";
import { fetchFromWikiServer } from "@lib/wiki-server";
import type { ClaimRow } from "@wiki-server/api-types";
import { ClaimsDashboard } from "./claims-dashboard";
import type { ClaimsDashboardData } from "./claims-dashboard";

export const metadata: Metadata = {
  title: "Claims Dashboard | Longterm Wiki Internal",
  description:
    "Global claims overview: coverage, categories, multi-entity relationships, and verification status.",
};

interface StatsResponse {
  total: number;
  byClaimType: Record<string, number>;
  byEntityType: Record<string, number>;
  byClaimCategory: Record<string, number>;
  multiEntityClaims: number;
  factLinkedClaims: number;
}

interface AllClaimsResponse {
  claims: ClaimRow[];
  total: number;
  limit: number;
  offset: number;
}

/** Fetch all claims via paginated /all endpoint. */
async function fetchAllClaims(): Promise<ClaimRow[]> {
  const PAGE_SIZE = 200;
  const all: ClaimRow[] = [];
  let offset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await fetchFromWikiServer<AllClaimsResponse>(
      `/api/claims/all?limit=${PAGE_SIZE}&offset=${offset}`,
      { revalidate: 300 }
    );
    if (!page || page.claims.length === 0) break;
    all.push(...page.claims);
    if (all.length >= page.total) break;
    offset += PAGE_SIZE;
  }
  return all;
}

export default async function ClaimsDashboardPage() {
  const [stats, claims] = await Promise.all([
    fetchFromWikiServer<StatsResponse>("/api/claims/stats", { revalidate: 300 }),
    fetchAllClaims(),
  ]);

  if (!stats) {
    return (
      <article className="prose max-w-none">
        <h1>Claims Dashboard</h1>
        <p className="text-muted-foreground">
          Wiki-server unavailable. Set <code>LONGTERMWIKI_SERVER_URL</code> to
          enable.
        </p>
      </article>
    );
  }

  // Build per-entity breakdown
  const entityMap = new Map<
    string,
    { total: number; verified: number; unverified: number; unsourced: number; multiEntity: number; categories: Record<string, number> }
  >();
  for (const claim of claims) {
    const eid = claim.entityId;
    if (!entityMap.has(eid)) {
      entityMap.set(eid, { total: 0, verified: 0, unverified: 0, unsourced: 0, multiEntity: 0, categories: {} });
    }
    const entry = entityMap.get(eid)!;
    entry.total++;
    if (claim.confidence === "verified") entry.verified++;
    else if (claim.confidence === "unsourced") entry.unsourced++;
    else entry.unverified++;
    if (claim.relatedEntities && claim.relatedEntities.length > 0) entry.multiEntity++;
    const cat = claim.claimCategory ?? "uncategorized";
    entry.categories[cat] = (entry.categories[cat] ?? 0) + 1;
  }

  const entityRows = [...entityMap.entries()]
    .map(([entityId, data]) => ({ entityId, ...data }))
    .sort((a, b) => b.total - a.total);

  // Build entity-pair relationship counts from relatedEntities
  const pairCounts = new Map<string, { from: string; to: string; count: number; sampleClaims: string[] }>();
  for (const claim of claims) {
    if (!claim.relatedEntities || claim.relatedEntities.length === 0) continue;
    for (const related of claim.relatedEntities) {
      const pair = [claim.entityId, related].sort().join(" <-> ");
      if (!pairCounts.has(pair)) {
        pairCounts.set(pair, {
          from: claim.entityId,
          to: related,
          count: 0,
          sampleClaims: [],
        });
      }
      const entry = pairCounts.get(pair)!;
      entry.count++;
      if (entry.sampleClaims.length < 2) {
        entry.sampleClaims.push(claim.claimText.slice(0, 120));
      }
    }
  }

  const relationshipRows = [...pairCounts.values()]
    .sort((a, b) => b.count - a.count);

  const data: ClaimsDashboardData = {
    stats,
    entityRows,
    relationshipRows,
    claims,
  };

  return (
    <article className="prose max-w-none">
      <h1>Claims Dashboard</h1>
      <p className="text-muted-foreground">
        Extracted claims across all wiki pages.{" "}
        <span className="font-medium text-foreground">{stats.total}</span> total
        claims from{" "}
        <span className="font-medium text-foreground">{entityRows.length}</span>{" "}
        entities.
      </p>

      {/* Global stats */}
      <div className="not-prose grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 mb-6">
        <StatCard label="Total Claims" value={stats.total} />
        <StatCard label="Entities" value={entityRows.length} />
        <StatCard label="Multi-Entity" value={stats.multiEntityClaims} />
        <StatCard label="Fact-Linked" value={stats.factLinkedClaims} />
        <StatCard label="Relationships" value={relationshipRows.length} />
        <StatCard label="Categorized" value={stats.total - (stats.byClaimCategory["uncategorized"] ?? 0)} />
      </div>

      <ClaimsDashboard data={data} />
    </article>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border p-3 text-center">
      <div className="text-2xl font-bold tabular-nums">{value.toLocaleString()}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
