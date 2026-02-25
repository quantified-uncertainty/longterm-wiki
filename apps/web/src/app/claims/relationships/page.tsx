import type { Metadata } from "next";
import { fetchFromWikiServer } from "@lib/wiki-server";
import {
  RelationshipsTable,
  type RelationshipRow,
} from "./relationships-table";

export const metadata: Metadata = {
  title: "Entity Relationships | Longterm Wiki Claims",
  description:
    "Entity pairs connected by shared claims across wiki pages.",
};

interface RelationshipsResponse {
  relationships: RelationshipRow[];
}

export default async function RelationshipsPage() {
  const result = await fetchFromWikiServer<RelationshipsResponse>(
    "/api/claims/relationships",
    { revalidate: 300 }
  );

  const relationships = result?.relationships ?? [];

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
        <RelationshipsTable relationships={relationships} />
      )}
    </div>
  );
}
