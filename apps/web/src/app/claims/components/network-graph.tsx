"use client";

import { useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  Controls,
  MiniMap,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Dagre from "@dagrejs/dagre";

interface NetworkNode {
  entityId: string;
  claimCount: number;
}

interface NetworkEdge {
  source: string;
  target: string;
  weight: number;
}

function EntityNode({ data }: { data: { label: string; claimCount: number } }) {
  const size = Math.max(40, Math.min(80, 30 + data.claimCount / 5));
  return (
    <div
      className="flex flex-col items-center justify-center rounded-lg border-2 border-blue-300 bg-white shadow-sm px-3 py-2 hover:border-blue-500 hover:shadow-md transition-all cursor-pointer"
      style={{ minWidth: size, minHeight: size }}
    >
      <span className="text-xs font-mono font-medium text-gray-800 text-center leading-tight">
        {data.label}
      </span>
      <span className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">
        {data.claimCount} claims
      </span>
    </div>
  );
}

const nodeTypes = { entity: EntityNode };

function layoutGraph(
  nodes: Node[],
  edges: Edge[]
): { nodes: Node[]; edges: Edge[] } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 80, ranksep: 100 });

  for (const node of nodes) {
    g.setNode(node.id, { width: 120, height: 60 });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  Dagre.layout(g);

  const layoutedNodes = nodes.map((node) => {
    const n = g.node(node.id);
    return {
      ...node,
      position: { x: n.x - 60, y: n.y - 30 },
    };
  });

  return { nodes: layoutedNodes, edges };
}

function NetworkGraphInner({
  nodes: rawNodes,
  edges: rawEdges,
}: {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}) {
  const router = useRouter();

  const maxWeight = Math.max(1, ...rawEdges.map((e) => e.weight));

  const { flowNodes, flowEdges } = useMemo(() => {
    const flowNodes: Node[] = rawNodes.map((n) => ({
      id: n.entityId,
      type: "entity",
      position: { x: 0, y: 0 },
      data: { label: n.entityId, claimCount: n.claimCount },
    }));

    const flowEdges: Edge[] = rawEdges.map((e, i) => ({
      id: `e-${i}`,
      source: e.source,
      target: e.target,
      style: {
        strokeWidth: Math.max(1, (e.weight / maxWeight) * 5),
        stroke: "#94a3b8",
      },
      label: String(e.weight),
      labelStyle: { fontSize: 10, fill: "#64748b" },
    }));

    const laid = layoutGraph(flowNodes, flowEdges);
    return { flowNodes: laid.nodes, flowEdges: laid.edges };
  }, [rawNodes, rawEdges, maxWeight]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      router.push(`/claims/entity/${node.id}`);
    },
    [router]
  );

  return (
    <div className="w-full h-[600px] border rounded-lg bg-gray-50">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        fitView
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Controls />
        <MiniMap
          nodeStrokeWidth={3}
          nodeColor="#dbeafe"
          className="!bg-white"
        />
      </ReactFlow>
    </div>
  );
}

export function NetworkGraph({
  nodes,
  edges,
}: {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}) {
  if (nodes.length === 0) {
    return (
      <div className="border rounded-lg p-8 text-center space-y-3">
        <p className="text-muted-foreground font-medium">
          No network data available
        </p>
        <p className="text-sm text-muted-foreground">
          The network graph requires claims with <code className="text-xs bg-muted px-1 py-0.5 rounded">relatedEntities</code> data
          to build connections between entities. Claims are populated when you
          run <code className="text-xs bg-muted px-1 py-0.5 rounded">pnpm crux claims extract &lt;entity&gt;</code>.
        </p>
        <p className="text-sm text-muted-foreground">
          Try <Link href="/claims/explore" className="text-blue-600 hover:underline">browsing claims</Link> to
          check if any claims exist, or <Link href="/claims/relationships" className="text-blue-600 hover:underline">view relationships</Link> for
          a table-based view of entity connections.
        </p>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <NetworkGraphInner nodes={nodes} edges={edges} />
    </ReactFlowProvider>
  );
}
