import { fetchFromWikiServer } from "@lib/wiki-server";
import type { ClaimRow } from "@wiki-server/api-types";

interface PaginatedClaimsResponse {
  claims: ClaimRow[];
  total: number;
  limit: number;
  offset: number;
}

/** Fetch all claims via paginated /all endpoint. */
export async function fetchAllClaims(): Promise<ClaimRow[]> {
  const PAGE_SIZE = 200;
  const all: ClaimRow[] = [];
  let offset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await fetchFromWikiServer<PaginatedClaimsResponse>(
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
