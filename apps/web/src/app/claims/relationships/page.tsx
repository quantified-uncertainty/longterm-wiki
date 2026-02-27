import type { Metadata } from "next";
import { fetchFromWikiServer } from "@lib/wiki-server";
import type { ClaimsRelationshipsResult } from "@wiki-server/api-response-types";
import { buildEntityNameMap } from "../components/claims-data";
import { RelationshipsTable } from "./relationships-table";

export const metadata: Metadata = {
  title: "Entity Relationships",
  description:
    "Entity pairs connected by shared claims across wiki pages.",
};

export default async function RelationshipsPage() {
  const result = await fetchFromWikiServer<ClaimsRelationshipsResult>(
    "/api/claims/relationships",
    { revalidate: 300 }
  );

  const relationships = result?.relationships ?? [];

  // Build entity name map from all entity slugs in relationships
  const allSlugs = new Set<string>();
  for (const r of relationships) {
    allSlugs.add(r.entityA);
    allSlugs.add(r.entityB);
  }
  const entityNames = buildEntityNameMap([...allSlugs]);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Entity Relationships</h1>
      <p className="text-muted-foreground mb-6">
        Entity pairs connected by shared claims.{" "}
        <span className="font-medium text-foreground">
          {relationships.length}
        </span>{" "}
        relationships found.
      </p>

      {relationships.length === 0 ? (
        <p className="text-muted-foreground">
          No multi-entity relationships found. Claims need{" "}
          <code>relatedEntities</code> data to build relationships.
        </p>
      ) : (
        <RelationshipsTable relationships={relationships} entityNames={entityNames} />
      )}
    </div>
  );
}
