import { fetchAllPaginated } from "@lib/fetch-paginated";
import { getEntityById } from "@data";
import type { ClaimRow } from "@wiki-server/api-response-types";

/** Convert a slug like "open-philanthropy" to "Open Philanthropy" as fallback */
function formatSlugAsTitle(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Build a slug → display-title map for a set of entity IDs */
export function buildEntityNameMap(slugs: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const slug of slugs) {
    const entity = getEntityById(slug);
    map[slug] = entity?.title ?? formatSlugAsTitle(slug);
  }
  return map;
}

/** Collect all unique entity slugs from claims (both entityId and relatedEntities).
 *  relatedEntities are already normalized (lowercased) by the server. */
export function collectEntitySlugs(claims: ClaimRow[]): string[] {
  const slugs = new Set<string>();
  for (const claim of claims) {
    slugs.add(claim.entityId);
    if (claim.relatedEntities) {
      for (const rel of claim.relatedEntities) {
        slugs.add(rel);
      }
    }
  }
  return [...slugs];
}

/** Fetch all claims via paginated /all endpoint.
 *  Uses the shared pagination helper with a 90s deadline and 30s per-page timeout
 *  to handle heavy load during static generation. */
export async function fetchAllClaims(): Promise<ClaimRow[]> {
  const result = await fetchAllPaginated<ClaimRow>({
    path: "/api/claims/all",
    itemsKey: "claims",
    pageSize: 1000,
    extraParams: "includeSources=true",
    revalidate: 300,
    timeoutMs: 30_000,
    deadlineMs: 90_000,
  });
  if (!result.ok) {
    console.warn(
      `[fetchAllClaims] Failed: ${result.error.type === "connection-error" ? result.error.message : result.error.type}`
    );
    return [];
  }
  return result.data.items;
}
