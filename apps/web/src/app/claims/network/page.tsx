import type { Metadata } from "next";
import { fetchFromWikiServer } from "@lib/wiki-server";
import type { ClaimsNetworkResult } from "@wiki-server/api-response-types";
import { buildEntityNameMap } from "../components/claims-data";
import { NetworkGraph } from "../components/network-graph";

export const metadata: Metadata = {
  title: "Entity Network",
  description:
    "Interactive network graph showing entity relationships via shared claims.",
};

export default async function NetworkPage() {
  const result = await fetchFromWikiServer<ClaimsNetworkResult>(
    "/api/claims/network",
    { revalidate: 300 }
  );

  const nodes = result?.nodes ?? [];
  const edges = result?.edges ?? [];
  const entityNames = buildEntityNameMap(nodes.map((n) => n.entityId));

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Entity Network</h1>
      <p className="text-muted-foreground mb-6">
        Interactive graph showing entities connected by shared claims.{" "}
        <span className="font-medium text-foreground">{nodes.length}</span>{" "}
        entities,{" "}
        <span className="font-medium text-foreground">{edges.length}</span>{" "}
        connections. Click a node to view its claims.
      </p>
      <NetworkGraph nodes={nodes} edges={edges} entityNames={entityNames} />
    </div>
  );
}
