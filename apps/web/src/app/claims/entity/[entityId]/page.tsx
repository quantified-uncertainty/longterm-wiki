import type { Metadata } from "next";
import Link from "next/link";
import { fetchFromWikiServer } from "@lib/wiki-server";
import {
  getEntityById,
  getResourcesForPage,
  getResourceById,
  getResourceCredibility,
} from "@data";
import type { GetClaimsResult } from "@wiki-server/api-types";
import { StatCard } from "../../components/stat-card";
import { ClaimsTable } from "../../components/claims-table";
import { DistributionBar } from "../../components/distribution-bar";
import {
  collectEntitySlugs,
  buildEntityNameMap,
} from "../../components/claims-data";
import { CredibilityBadge } from "@/components/wiki/CredibilityBadge";
import { getResourceTypeIcon } from "@/components/wiki/resource-utils";

interface PageProps {
  params: Promise<{ entityId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { entityId } = await params;
  const entity = getEntityById(entityId);
  const displayName = entity?.title ?? entityId;
  return {
    title: `${displayName} Claims`,
    description: `Claims extracted from the ${displayName} wiki page.`,
  };
}

export default async function EntityClaimsPage({ params }: PageProps) {
  const { entityId } = await params;

  const result = await fetchFromWikiServer<GetClaimsResult>(
    `/api/claims/by-entity/${encodeURIComponent(entityId)}?includeSources=true`,
    { revalidate: 300 }
  );

  const claims = result?.claims ?? [];
  const entity = getEntityById(entityId);
  const displayName = entity?.title ?? entityId;
  const entityNames = buildEntityNameMap(collectEntitySlugs(claims));

  // Resolve page resources for the "Page Resources" section
  const resourceIds = getResourcesForPage(entityId);
  const resources = resourceIds
    .map((id) => getResourceById(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  // Compute stats
  const verified = claims.filter((c) => c.confidence === "verified").length;
  const multiEntity = claims.filter(
    (c) => c.relatedEntities && c.relatedEntities.length > 0
  ).length;
  const attributed = claims.filter((c) => c.claimMode === "attributed").length;
  const withSources = claims.filter(
    (c) => c.sources && c.sources.length > 0
  ).length;
  const withNumeric = claims.filter(
    (c) => c.valueNumeric != null || c.valueLow != null || c.valueHigh != null
  ).length;

  const byCategory: Record<string, number> = {};
  for (const c of claims) {
    const cat = c.claimCategory ?? "uncategorized";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-2xl font-bold">{displayName}</h1>
          <Link
            href={`/wiki/${entityId}`}
            className="text-xs text-blue-600 hover:underline"
          >
            View wiki page &rarr;
          </Link>
          <Link
            href={`/wiki/${entityId}/data`}
            className="text-xs text-muted-foreground hover:underline"
          >
            Data page
          </Link>
        </div>
        <p className="text-muted-foreground text-sm">
          {claims.length === 0
            ? "No claims extracted for this entity yet."
            : `${claims.length} claims extracted from this entity's wiki page.`}
        </p>
      </div>

      {claims.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-6">
            <StatCard label="Total Claims" value={claims.length} />
            <StatCard label="Multi-Entity" value={multiEntity} />
            {withSources > 0 && (
              <StatCard label="With Sources" value={withSources} />
            )}
            {attributed > 0 && (
              <StatCard label="Attributed" value={attributed} />
            )}
            {withNumeric > 0 && (
              <StatCard label="Numeric" value={withNumeric} />
            )}
            {verified > 0 && (
              <StatCard label="Verified" value={verified} />
            )}
          </div>

          {Object.keys(byCategory).length > 0 && (
            <div className="rounded-lg border p-4 mb-6">
              <h3 className="text-sm font-semibold mb-3">
                Category Distribution
              </h3>
              <DistributionBar data={byCategory} total={claims.length} />
            </div>
          )}

          <ClaimsTable claims={claims} entityNames={entityNames} />
        </>
      )}

      {resources.length > 0 && (
        <div className="mt-8">
          <details open={resources.length <= 5}>
            <summary className="text-sm font-semibold cursor-pointer select-none list-none flex items-center gap-2">
              <span>Page Resources</span>
              <span className="text-xs font-normal text-muted-foreground">
                ({resources.length})
              </span>
              {resources.length > 5 && (
                <span className="text-xs text-muted-foreground">
                  — click to expand
                </span>
              )}
            </summary>
            <div className="mt-3 space-y-2">
              {resources.map((resource) => {
                const credibility = getResourceCredibility(resource);
                return (
                  <div
                    key={resource.id}
                    className="flex items-center gap-3 rounded border px-3 py-2 text-sm"
                  >
                    <span className="text-base leading-none shrink-0">
                      {getResourceTypeIcon(resource.type)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <a
                        href={resource.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-blue-600 hover:underline"
                      >
                        {resource.title}
                      </a>
                    </div>
                    <span className="text-[10px] text-muted-foreground capitalize shrink-0">
                      {resource.type}
                    </span>
                    {credibility !== undefined && (
                      <CredibilityBadge level={credibility} />
                    )}
                  </div>
                );
              })}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
