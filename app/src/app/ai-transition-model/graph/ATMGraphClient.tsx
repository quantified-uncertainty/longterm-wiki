"use client";

import { useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import CauseEffectGraph from "@/components/wiki/CauseEffectGraph";
import { DetailsPanel } from "@/components/wiki/CauseEffectGraph/components";
import type { CauseEffectNodeData, CauseEffectEdgeData, GraphConfig } from "@/components/wiki/CauseEffectGraph/types";
import type { Node, Edge } from "@xyflow/react";

const graphConfig: GraphConfig = {
  layout: {
    containerWidth: 1600,
    centerX: 800,
    layerGap: 60,
    causeSpacing: 8,
    intermediateSpacing: 200,
    effectSpacing: 400,
  },
  typeLabels: {
    cause: "Root Factors",
    intermediate: "Ultimate Scenarios",
    effect: "Ultimate Outcomes",
  },
  subgroups: {
    ai: {
      label: "AI System Factors",
      bgColor: "rgba(219, 234, 254, 0.2)",
      borderColor: "transparent",
    },
    society: {
      label: "Societal Factors",
      bgColor: "rgba(209, 250, 229, 0.2)",
      borderColor: "transparent",
    },
  },
};

interface ATMGraphClientProps {
  initialNodes: Node<CauseEffectNodeData>[];
  initialEdges: Edge<CauseEffectEdgeData>[];
}

export function ATMGraphClient({ initialNodes, initialEdges }: ATMGraphClientProps) {
  const searchParams = useSearchParams();
  const nodeParam = searchParams.get("node");

  const [selectedNode, setSelectedNode] = useState<Node<CauseEffectNodeData> | null>(() => {
    if (!nodeParam) return null;
    return initialNodes.find((n) => n.id === nodeParam) ?? null;
  });

  // Use URL param as selectedNodeId for visual highlighting in the graph
  const selectedNodeId = selectedNode?.id ?? nodeParam ?? undefined;

  const handleNodeClick = useCallback((node: Node<CauseEffectNodeData>) => {
    setSelectedNode((prev) => (prev?.id === node.id ? null : node));
  }, []);

  return (
    <div style={{ height: "calc(100vh - 57px)", position: "relative" }}>
      <CauseEffectGraph
        initialNodes={initialNodes}
        initialEdges={initialEdges}
        height="100%"
        showFullscreenButton={true}
        enablePathHighlighting={true}
        showMiniMap={true}
        graphConfig={graphConfig}
        onNodeClick={handleNodeClick}
        selectedNodeId={selectedNodeId}
      />
      <DetailsPanel
        node={selectedNode}
        onClose={() => setSelectedNode(null)}
      />
    </div>
  );
}
