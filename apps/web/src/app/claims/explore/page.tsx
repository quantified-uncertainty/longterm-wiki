import type { Metadata } from "next";
import { Suspense } from "react";
import {
  fetchAllClaims,
  collectEntitySlugs,
  buildEntityNameMap,
} from "../components/claims-data";
import { ClaimsExplorer } from "./claims-explorer";

// Skip static generation — fetches all claims from wiki-server which is
// too heavy to run during build alongside hundreds of other API requests.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Browse Claims",
  description: "Search and filter all extracted claims across wiki pages.",
};

export default async function ExplorePage() {
  const claims = await fetchAllClaims();

  const entities = [...new Set(claims.map((c) => c.entityId))].sort();
  const categories = [
    ...new Set(claims.map((c) => c.claimCategory ?? "uncategorized")),
  ].sort();
  const entityNames = buildEntityNameMap(collectEntitySlugs(claims));

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
          entityNames={entityNames}
        />
      </Suspense>
    </div>
  );
}
