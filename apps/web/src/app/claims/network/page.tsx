import type { Metadata } from "next";
import { fetchFromWikiServer } from "@lib/wiki-server";
import { NetworkGraph } from "../components/network-graph";

export const metadata: Metadata = {
  title: "Entity Network | Longterm Wiki Claims",
  description:
    "Interactive network graph showing entity relationships via shared claims.",
};

interface NetworkResponse {
  nodes: { entityId: string; claimCount: number }[];
  edges: { source: string; target: string; weight: number }[];
}

export default async function NetworkPage() {
  const result = await fetchFromWikiServer<NetworkResponse>(
    "/api/claims/network",
    { revalidate: 300 }
  );

  const nodes = result?.nodes ?? [];
  const edges = result?.edges ?? [];

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
      <NetworkGraph nodes={nodes} edges={edges} />
    </div>
  );
}
