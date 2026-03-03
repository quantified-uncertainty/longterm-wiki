import type { Metadata } from "next";
import Link from "next/link";
import { fetchFromWikiServer } from "@lib/wiki-server";
import {
  getEntityById,
  getEntityHref,
  getResourcesForPage,
  getResourceById,
  getResourceCredibility,
} from "@data";
import type { GetClaimsResult, ClaimRow } from "@wiki-server/api-response-types";
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import { StatCard } from "../../components/stat-card";
import { DistributionBar } from "../../components/distribution-bar";
import {
  collectEntitySlugs,
  buildEntityNameMap,
} from "../../components/claims-data";
import { EntityClaimsViews } from "./entity-claims-views";
import { CredibilityBadge } from "@/components/wiki/CredibilityBadge";
import { getResourceTypeIcon } from "@/components/wiki/resource-utils";

let _propertyLabelsCache: Record<string, string> | null = null;
/**
 * Build property label map from the unified taxonomy (fact-measures.yaml).
 * Includes both measure IDs (kebab-case) and claim property aliases (snake_case).
 */
function loadPropertyLabels(): Record<string, string> {
  if (_propertyLabelsCache) return _propertyLabelsCache;
  try {
    // Load from unified taxonomy
    const raw = readFileSync(
      join(process.cwd(), "../../data/fact-measures.yaml"),
      "utf-8"
    );
    const data = parse(raw) as {
      measures: Record<string, { label: string }>;
      propertyAliases?: Record<string, string>;
    };
    const map: Record<string, string> = {};
    // Add measure labels (kebab-case IDs)
    for (const [id, measure] of Object.entries(data.measures)) {
      map[id] = measure.label;
    }
    // Add aliases: map snake_case claim property → measure label
    if (data.propertyAliases) {
      for (const [alias, measureId] of Object.entries(data.propertyAliases)) {
        if (data.measures[measureId]) {
          map[alias] = data.measures[measureId].label;
        }
      }
    }
    _propertyLabelsCache = map;
    return map;
  } catch {
    return {};
  }
}

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

/** Compute related entity stats and render a chip-list for graph navigation. */
function ConnectedEntities({
  claims,
  entityId,
  entityNames,
}: {
  claims: GetClaimsResult["claims"];
  entityId: string;
  entityNames: Record<string, string>;
}) {
  // relatedEntities are already normalized (lowercased) by the server
  const relatedStats = new Map<string, number>();
  for (const c of claims) {
    if (!c.relatedEntities) continue;
    for (const rel of c.relatedEntities) {
      if (rel === entityId) continue;
      relatedStats.set(rel, (relatedStats.get(rel) ?? 0) + 1);
    }
  }
  // Also count claims where this entity appears as a relatedEntity (not primary)
  for (const c of claims) {
    if (c.entityId !== entityId && c.entityId) {
      relatedStats.set(c.entityId, (relatedStats.get(c.entityId) ?? 0) + 1);
    }
  }
  const related = [...relatedStats.entries()].sort((a, b) => b[1] - a[1]);
  if (related.length === 0) return null;

  return (
    <div className="rounded-lg border p-4 mb-6">
      <h3 className="text-sm font-semibold mb-3">
        Connected Entities
        <span className="text-xs font-normal text-muted-foreground ml-2">
          ({related.length})
        </span>
      </h3>
      <div className="flex flex-wrap gap-2">
        {related.map(([eid, count]) => (
          <Link
            key={eid}
            href={`/claims/entity/${eid}`}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 transition-colors"
          >
            <span>{entityNames[eid] ?? eid.replace(/-/g, " ")}</span>
            <span className="text-blue-400 font-mono text-[10px]">{count}</span>
          </Link>
        ))}
      </div>
    </div>
  );
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

  // Count how many claims cite each resource (by resourceId or URL match)
  const resourceCitationCounts = new Map<string, number>();
  for (const claim of claims) {
    if (!claim.sources) continue;
    for (const source of claim.sources) {
      if (source.resourceId) {
        resourceCitationCounts.set(
          source.resourceId,
          (resourceCitationCounts.get(source.resourceId) ?? 0) + 1
        );
      }
    }
  }

  // Compute stats
  const verified = claims.filter((c: ClaimRow) => c.confidence === "verified").length;
  const multiEntity = claims.filter(
    (c: ClaimRow) => c.relatedEntities && c.relatedEntities.length > 0
  ).length;
  const attributed = claims.filter((c: ClaimRow) => c.claimMode === "attributed").length;
  const withSources = claims.filter(
    (c: ClaimRow) => c.sources && c.sources.length > 0
  ).length;
  const withNumeric = claims.filter(
    (c: ClaimRow) => c.valueNumeric != null || c.valueLow != null || c.valueHigh != null
  ).length;
  const verdictVerified = claims.filter((c: ClaimRow) => c.claimVerdict === "verified").length;
  const verdictDisputed = claims.filter((c: ClaimRow) => c.claimVerdict === "disputed").length;
  const verdictUnsupported = claims.filter((c: ClaimRow) => c.claimVerdict === "unsupported").length;

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
            href={getEntityHref(entityId)}
            className="text-xs text-blue-600 hover:underline"
          >
            View wiki page &rarr;
          </Link>
          <Link
            href={`${getEntityHref(entityId)}/data`}
            className="text-xs text-muted-foreground hover:underline"
          >
            Data page
          </Link>
        </div>
        <p className="text-muted-foreground text-sm">
          {claims.length === 0
            ? "No claims found for this entity yet."
            : (() => {
                const primary = claims.filter((c: ClaimRow) => c.entityId === entityId).length;
                const mentioned = claims.length - primary;
                if (mentioned === 0) return `${claims.length} claims extracted from this entity's wiki page.`;
                if (primary === 0) return `${mentioned} claims mentioning this entity from other pages.`;
                return `${primary} claims from this entity's page, ${mentioned} mentioning it from other pages.`;
              })()}
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
            {verdictVerified > 0 && (
              <StatCard label="Verdict: Verified" value={verdictVerified} />
            )}
            {verdictDisputed > 0 && (
              <StatCard label="Verdict: Disputed" value={verdictDisputed} />
            )}
            {verdictUnsupported > 0 && (
              <StatCard label="Verdict: Unsupported" value={verdictUnsupported} />
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

          {/* Related Entities — graph navigation */}
          <ConnectedEntities
            claims={claims}
            entityId={entityId}
            entityNames={entityNames}
          />

          <EntityClaimsViews claims={claims} entityNames={entityNames} />
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
                const citedInCount = resourceCitationCounts.get(resource.id) ?? 0;
                return (
                  <div
                    key={resource.id}
                    className="flex items-center gap-3 rounded border px-3 py-2 text-sm"
                  >
                    <span className="text-base leading-none shrink-0">
                      {getResourceTypeIcon(resource.type)}
                    </span>
                    <div className="flex-1 min-w-0">
                      <Link
                        href={`/source/${resource.id}`}
                        className="font-medium text-blue-600 hover:underline"
                      >
                        {resource.title}
                      </Link>
                    </div>
                    {citedInCount > 0 && (
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {citedInCount} {citedInCount === 1 ? "claim" : "claims"}
                      </span>
                    )}
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