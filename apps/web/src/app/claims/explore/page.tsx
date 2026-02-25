import type { Metadata } from "next";
import { Suspense } from "react";
import { fetchFromWikiServer } from "@lib/wiki-server";
import type { ClaimRow } from "@wiki-server/api-types";
import { ClaimsExplorer } from "./claims-explorer";

export const metadata: Metadata = {
  title: "Browse Claims | Longterm Wiki",
  description: "Search and filter all extracted claims across wiki pages.",
};

interface AllClaimsResponse {
  claims: ClaimRow[];
  total: number;
  limit: number;
  offset: number;
}

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

export default async function ExplorePage() {
  const claims = await fetchAllClaims();

  const entities = [...new Set(claims.map((c) => c.entityId))].sort();
  const categories = [
    ...new Set(claims.map((c) => c.claimCategory ?? "uncategorized")),
  ].sort();

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Browse Claims</h1>
      <p className="text-muted-foreground mb-6">
        Search and filter{" "}
        <span className="font-medium text-foreground">
          {claims.length.toLocaleString()}
        </span>{" "}
        claims across all entities. Click a row to expand details.
      </p>
      <Suspense>
        <ClaimsExplorer
          claims={claims}
          entities={entities}
          categories={categories}
        />
      </Suspense>
    </div>
  );
}
