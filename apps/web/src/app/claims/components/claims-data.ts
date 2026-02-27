import { fetchFromWikiServer } from "@lib/wiki-server";
import { getEntityById } from "@data";
import type { ClaimRow, GetAllClaimsResult } from "@wiki-server/api-response-types";

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
 *  Uses a larger page size and longer timeout to avoid build timeouts
 *  when the wiki-server is under heavy load during static generation. */
export async function fetchAllClaims(): Promise<ClaimRow[]> {
  const PAGE_SIZE = 1000;
  const all: ClaimRow[] = [];
  let offset = 0;
  const deadline = Date.now() + 90_000; // 90s total budget

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() > deadline) break;
    const page = await fetchFromWikiServer<GetAllClaimsResult>(
      `/api/claims/all?limit=${PAGE_SIZE}&offset=${offset}&includeSources=true`,
      { revalidate: 300, timeoutMs: 30_000 }
    );
    if (!page || page.claims.length === 0) break;
    all.push(...page.claims);
    if (all.length >= page.total) break;
    offset += PAGE_SIZE;
  }
  return all;
}
