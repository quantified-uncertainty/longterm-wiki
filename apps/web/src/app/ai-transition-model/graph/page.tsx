import { Suspense } from "react";
import type { Metadata } from "next";
import { getRawGraphData } from "@/data/parameter-graph-data";
import type { CauseEffectNodeData, CauseEffectEdgeData } from "@/components/wiki/CauseEffectGraph/types";
import type { Node, Edge } from "@xyflow/react";
import { ATMGraphClient } from "./ATMGraphClient";

export const metadata: Metadata = {
  title: "AI Transition Model — Graph View",
  description:
    "Interactive causal diagram showing relationships between factors, scenarios, and outcomes in the AI transition model.",
};

export default function ATMGraphPage() {
  const raw = getRawGraphData();

  // Transform to ReactFlow nodes
  const nodes: Node<CauseEffectNodeData>[] = raw.nodes.map((node) => ({
    id: node.id,
    type: "causeEffect" as const,
    position: { x: 0, y: 0 },
    data: {
      label: node.label,
      description: node.description,
      type: node.type,
      order: node.order,
      subgroup: node.subgroup,
      href: node.href,
      suppressNavigation: true,  // Use DetailsPanel + path highlighting instead of direct navigation
      subItems: node.subItems?.map((item) => ({
        label: item.label,
        href: item.href,
        entityId: item.entityId,
        description: item.description,
        scope: item.scope,
        ratings: item.ratings,
        keyDebates: item.keyDebates,
      })),
      confidence: node.confidence,
      confidenceLabel: node.confidenceLabel,
      nodeColors: node.nodeColors,
    },
  }));

  // Transform to ReactFlow edges
  const edges: Edge<CauseEffectEdgeData>[] = raw.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: {
      label: edge.label,
      strength: edge.strength,
      effect: edge.effect,
    },
  }));

  // Serialize for client component (strips non-serializable values)
  const serializedNodes = JSON.parse(JSON.stringify(nodes));
  const serializedEdges = JSON.parse(JSON.stringify(edges));

  return (
    <Suspense>
      <ATMGraphClient
        initialNodes={serializedNodes}
        initialEdges={serializedEdges}
      />
    </Suspense>
  );
}
