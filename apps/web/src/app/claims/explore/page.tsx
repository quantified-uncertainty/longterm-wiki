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
  const verdicts = [
    ...new Set(
      claims
        .map((c) => c.claimVerdict)
        .filter((v): v is string => v != null)
    ),
  ].sort();
  const entityNames = buildEntityNameMap(collectEntitySlugs(claims));

  // Compute quality summary stats
  const verifiedCount = claims.filter(
    (c) => c.claimVerdict != null
  ).length;
  const withScore = claims.filter(
    (c) => c.claimVerdictScore != null
  );
  const avgScore =
    withScore.length > 0
      ? withScore.reduce(
          (sum, c) => sum + (c.claimVerdictScore ?? 0),
          0
        ) / withScore.length
      : null;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Browse Claims</h1>
      <p className="text-muted-foreground mb-4">
        Search and filter{" "}
        <span className="font-medium text-foreground">
          {claims.length.toLocaleString()}
        </span>{" "}
        claims across all entities. Click a row to expand details.
      </p>
      {/* Quality summary bar */}
      <div className="flex flex-wrap gap-4 mb-6 text-sm">
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-muted/50">
          <span className="text-muted-foreground">Verified:</span>
          <span className="font-medium">
            {verifiedCount.toLocaleString()} /{" "}
            {claims.length.toLocaleString()}
          </span>
          <span className="text-muted-foreground">
            (
            {claims.length > 0
              ? Math.round((verifiedCount / claims.length) * 100)
              : 0}
            %)
          </span>
        </div>
        {avgScore != null && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-muted/50">
            <span className="text-muted-foreground">Avg score:</span>
            <span className="font-medium">
              {Math.round(avgScore * 100)}%
            </span>
          </div>
        )}
        {verdicts.length > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-muted/50">
            <span className="text-muted-foreground">Verdicts:</span>
            <span className="font-medium">
              {verdicts.map((v) => v.replace(/_/g, " ")).join(", ")}
            </span>
          </div>
        )}
      </div>
      <Suspense>
        <ClaimsExplorer
          claims={claims}
          entities={entities}
          categories={categories}
          verdicts={verdicts}
          entityNames={entityNames}
        />
      </Suspense>
    </div>
  );
}
