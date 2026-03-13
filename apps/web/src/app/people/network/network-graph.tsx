"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import Dagre from "@dagrejs/dagre";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Types (shared between server page and client component)
// ---------------------------------------------------------------------------

export interface NetworkNode {
  id: string;
  label: string;
  type: "person" | "organization";
  slug: string;
  numericId?: string;
  role?: string;
  employer?: string;
  topicCount?: number;
}

export interface NetworkEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  isFounder: boolean;
  isCurrent: boolean;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const NODE_WIDTH_PERSON = 160;
const NODE_HEIGHT_PERSON = 50;
const NODE_WIDTH_ORG = 180;
const NODE_HEIGHT_ORG = 60;

function layoutGraph(
  networkNodes: NetworkNode[],
  networkEdges: NetworkEdge[],
): { nodes: Node[]; edges: Edge[] } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "LR",
    nodesep: 30,
    ranksep: 120,
    marginx: 20,
    marginy: 20,
  });

  for (const n of networkNodes) {
    const isOrg = n.type === "organization";
    g.setNode(n.id, {
      width: isOrg ? NODE_WIDTH_ORG : NODE_WIDTH_PERSON,
      height: isOrg ? NODE_HEIGHT_ORG : NODE_HEIGHT_PERSON,
    });
  }

  for (const e of networkEdges) {
    g.setEdge(e.source, e.target);
  }

  Dagre.layout(g);

  const nodes: Node[] = networkNodes.map((n) => {
    const pos = g.node(n.id);
    const isOrg = n.type === "organization";
    return {
      id: n.id,
      type: "default",
      position: {
        x: (pos?.x ?? 0) - (isOrg ? NODE_WIDTH_ORG : NODE_WIDTH_PERSON) / 2,
        y: (pos?.y ?? 0) - (isOrg ? NODE_HEIGHT_ORG : NODE_HEIGHT_PERSON) / 2,
      },
      data: { label: n.label, nodeData: n },
      style: {
        width: isOrg ? NODE_WIDTH_ORG : NODE_WIDTH_PERSON,
        height: isOrg ? NODE_HEIGHT_ORG : NODE_HEIGHT_PERSON,
        background: isOrg ? "#dbeafe" : "#fef3c7",
        border: isOrg ? "2px solid #3b82f6" : "2px solid #f59e0b",
        borderRadius: isOrg ? "8px" : "50px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "11px",
        fontWeight: 600,
        padding: "4px 8px",
        textAlign: "center" as const,
        cursor: "pointer",
      },
    };
  });

  const edges: Edge[] = networkEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    animated: e.isFounder,
    style: {
      stroke: e.isCurrent ? "#6366f1" : "#94a3b8",
      strokeWidth: e.isFounder ? 2.5 : 1.5,
      strokeDasharray: e.isCurrent ? undefined : "5 5",
    },
    labelStyle: { fontSize: 9, fill: "#64748b" },
    labelBgStyle: { fill: "#f8fafc", fillOpacity: 0.9 },
    labelBgPadding: [4, 2] as [number, number],
  }));

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function NodeDetail({
  node,
  edges,
  allNodes,
}: {
  node: NetworkNode;
  edges: NetworkEdge[];
  allNodes: NetworkNode[];
}) {
  const nodeMap = useMemo(
    () => new Map(allNodes.map((n) => [n.id, n])),
    [allNodes],
  );

  const connections = edges.filter(
    (e) => e.source === node.id || e.target === node.id,
  );

  const href = node.numericId
    ? `/wiki/${node.numericId}`
    : node.type === "person"
      ? `/people/${node.slug}`
      : `/organizations/${node.slug}`;

  return (
    <div className="border rounded-lg bg-card p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <Link
            href={href}
            className="text-base font-semibold hover:underline"
          >
            {node.label}
          </Link>
          <p className="text-xs text-muted-foreground capitalize">
            {node.type}
            {node.role ? ` \u2014 ${node.role}` : ""}
          </p>
        </div>
        <span
          className={`inline-block w-3 h-3 rounded-full ${
            node.type === "organization" ? "bg-blue-400" : "bg-amber-400"
          }`}
        />
      </div>
      {connections.length > 0 && (
        <div>
          <p className="text-xs font-medium mb-1 text-muted-foreground">
            Connections ({connections.length})
          </p>
          <ul className="text-xs space-y-1">
            {connections.map((c) => {
              const otherId = c.source === node.id ? c.target : c.source;
              const other = nodeMap.get(otherId);
              return (
                <li key={c.id} className="flex items-center gap-1.5">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      other?.type === "organization"
                        ? "bg-blue-400"
                        : "bg-amber-400"
                    }`}
                  />
                  <span>{other?.label ?? otherId}</span>
                  <span className="text-muted-foreground">
                    &middot; {c.label}
                    {c.isFounder ? " (founder)" : ""}
                    {!c.isCurrent ? " (past)" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main graph component
// ---------------------------------------------------------------------------

function NetworkGraphInner({
  nodes: networkNodes,
  edges: networkEdges,
  orgNames,
}: {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  orgNames: string[];
}) {
  const [selectedNode, setSelectedNode] = useState<NetworkNode | null>(null);
  const [orgFilter, setOrgFilter] = useState<string>("all");
  const [showPastRoles, setShowPastRoles] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  // Filter edges and nodes
  const { filteredNodes, filteredEdges } = useMemo(() => {
    const nodeMap = new Map(networkNodes.map((n) => [n.id, n]));

    // Filter edges
    let edgesFiltered = networkEdges;
    if (!showPastRoles) {
      edgesFiltered = edgesFiltered.filter((e) => e.isCurrent);
    }
    if (orgFilter !== "all") {
      const orgNode = networkNodes.find(
        (n) => n.type === "organization" && n.label === orgFilter,
      );
      if (orgNode) {
        edgesFiltered = edgesFiltered.filter(
          (e) => e.source === orgNode.id || e.target === orgNode.id,
        );
      }
    }

    // Determine connected node IDs
    const connectedIds = new Set<string>();
    for (const e of edgesFiltered) {
      connectedIds.add(e.source);
      connectedIds.add(e.target);
    }

    let nodesFiltered = networkNodes.filter((n) => connectedIds.has(n.id));

    // Apply text search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchingIds = new Set(
        nodesFiltered
          .filter(
            (n) =>
              n.label.toLowerCase().includes(q) ||
              (n.role && n.role.toLowerCase().includes(q)),
          )
          .map((n) => n.id),
      );
      // Keep matched nodes and their direct connections
      const expandedIds = new Set(matchingIds);
      for (const e of edgesFiltered) {
        if (matchingIds.has(e.source)) expandedIds.add(e.target);
        if (matchingIds.has(e.target)) expandedIds.add(e.source);
      }
      nodesFiltered = nodesFiltered.filter((n) => expandedIds.has(n.id));
      edgesFiltered = edgesFiltered.filter(
        (e) => expandedIds.has(e.source) && expandedIds.has(e.target),
      );
    }

    return { filteredNodes: nodesFiltered, filteredEdges: edgesFiltered };
  }, [networkNodes, networkEdges, orgFilter, showPastRoles, searchQuery]);

  // Layout
  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => layoutGraph(filteredNodes, filteredEdges),
    [filteredNodes, filteredEdges],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);

  // Sync when filters change
  useEffect(() => {
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
  }, [layoutedNodes, layoutedEdges, setNodes, setEdges]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const data = (node.data as { nodeData?: NetworkNode })?.nodeData;
      if (data) setSelectedNode(data);
    },
    [],
  );

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search people or orgs..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring w-56"
        />
        <select
          value={orgFilter}
          onChange={(e) => setOrgFilter(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="all">All organizations</option>
          {orgNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={showPastRoles}
            onChange={(e) => setShowPastRoles(e.target.checked)}
            className="rounded"
          />
          Show past roles
        </label>
        <span className="text-xs text-muted-foreground ml-auto">
          {filteredNodes.filter((n) => n.type === "person").length} people
          &middot;{" "}
          {filteredNodes.filter((n) => n.type === "organization").length} orgs
          &middot; {filteredEdges.length} connections
        </span>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-amber-300 border border-amber-500 inline-block" />
          Person
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-blue-200 border-2 border-blue-500 inline-block" />
          Organization
        </span>
        <span className="flex items-center gap-1">
          <span className="w-6 border-t-2 border-indigo-500 inline-block" />
          Current role
        </span>
        <span className="flex items-center gap-1">
          <span className="w-6 border-t-2 border-dashed border-slate-400 inline-block" />
          Past role
        </span>
        <span className="flex items-center gap-1">
          <span className="w-6 border-t-[3px] border-indigo-500 inline-block" />
          Founder
        </span>
      </div>

      {/* Graph + Detail */}
      <div className="flex gap-4">
        <div
          className="border rounded-lg overflow-hidden flex-1"
          style={{ height: 600 }}
        >
          {filteredNodes.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              No connections match the current filters.
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={onNodeClick}
              fitView
              fitViewOptions={{ padding: 0.15 }}
              minZoom={0.1}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Controls showInteractive={false} />
              <MiniMap
                nodeColor={(n) => {
                  const data = (n.data as { nodeData?: NetworkNode })
                    ?.nodeData;
                  return data?.type === "organization" ? "#93c5fd" : "#fcd34d";
                }}
                style={{ width: 120, height: 80 }}
              />
            </ReactFlow>
          )}
        </div>

        {/* Side panel */}
        <div className="w-72 shrink-0 hidden lg:block">
          {selectedNode ? (
            <NodeDetail
              node={selectedNode}
              edges={networkEdges}
              allNodes={networkNodes}
            />
          ) : (
            <div className="border rounded-lg bg-card p-4 text-sm text-muted-foreground">
              Click a node to see details.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function NetworkGraph(props: {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  orgNames: string[];
}) {
  return (
    <ReactFlowProvider>
      <NetworkGraphInner {...props} />
    </ReactFlowProvider>
  );
}
