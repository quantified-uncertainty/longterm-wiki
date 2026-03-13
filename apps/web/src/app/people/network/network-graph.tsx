"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  label: string;
  type: "person" | "organization";
  href: string;
  /** Extra detail shown on hover (role, affiliation) */
  detail?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
}

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number;
  fy?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PERSON_RADIUS = 8;
const ORG_SIZE = 12;
const LINK_DISTANCE = 100;
const CHARGE_STRENGTH = -300;
const CENTER_STRENGTH = 0.05;
const DAMPING = 0.92;
const MIN_ALPHA = 0.001;
const INITIAL_ALPHA = 1.0;

// Colors
const PERSON_FILL = "#6366f1"; // indigo-500
const PERSON_FILL_HIGHLIGHT = "#818cf8"; // indigo-400
const ORG_FILL = "#f59e0b"; // amber-500
const ORG_FILL_HIGHLIGHT = "#fbbf24"; // amber-400
const EDGE_STROKE = "#d1d5db"; // gray-300
const EDGE_STROKE_HIGHLIGHT = "#6366f1"; // indigo-500
const TEXT_FILL = "#374151"; // gray-700
const TOOLTIP_BG = "#1f2937"; // gray-800
const TOOLTIP_TEXT = "#f9fafb"; // gray-50

// ---------------------------------------------------------------------------
// Force simulation (simple, no dependencies)
// ---------------------------------------------------------------------------

function initPositions(nodes: GraphNode[], w: number, h: number): SimNode[] {
  return nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    const radius = Math.min(w, h) * 0.35;
    return {
      ...n,
      x: w / 2 + radius * Math.cos(angle),
      y: h / 2 + radius * Math.sin(angle),
      vx: 0,
      vy: 0,
    };
  });
}

function tick(
  nodes: SimNode[],
  edges: GraphEdge[],
  w: number,
  h: number,
  alpha: number,
): number {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Charge repulsion (all pairs)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) dist = 1;
      const force = (CHARGE_STRENGTH * alpha) / (dist * dist);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  // Spring forces along edges
  for (const edge of edges) {
    const s = nodeMap.get(edge.source);
    const t = nodeMap.get(edge.target);
    if (!s || !t) continue;
    let dx = t.x - s.x;
    let dy = t.y - s.y;
    let dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) dist = 1;
    const force = ((dist - LINK_DISTANCE) * alpha * 0.3) / dist;
    const fx = dx * force;
    const fy = dy * force;
    s.vx += fx;
    s.vy += fy;
    t.vx -= fx;
    t.vy -= fy;
  }

  // Center gravity
  for (const n of nodes) {
    n.vx += (w / 2 - n.x) * CENTER_STRENGTH * alpha;
    n.vy += (h / 2 - n.y) * CENTER_STRENGTH * alpha;
  }

  // Update positions
  const padding = 30;
  for (const n of nodes) {
    if (n.fx !== undefined) {
      n.x = n.fx;
      n.y = n.fy!;
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    n.x += n.vx;
    n.y += n.vy;
    // Keep inside bounds
    n.x = Math.max(padding, Math.min(w - padding, n.x));
    n.y = Math.max(padding, Math.min(h - padding, n.y));
  }

  return alpha * 0.99; // decay
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NetworkGraph({
  nodes,
  edges,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 600 });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(
    null,
  );

  // Track drag state
  const dragRef = useRef<{
    nodeId: string | null;
    wasDragged: boolean;
  }>({ nodeId: null, wasDragged: false });

  // Simulation state
  const simNodesRef = useRef<SimNode[]>([]);
  const alphaRef = useRef(INITIAL_ALPHA);
  const rafRef = useRef<number>(0);
  const [renderTick, setRenderTick] = useState(0);

  // Resize observer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        const height = Math.max(400, Math.min(800, width * 0.65));
        setDimensions({ width, height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Initialize simulation
  useEffect(() => {
    simNodesRef.current = initPositions(
      nodes,
      dimensions.width,
      dimensions.height,
    );
    alphaRef.current = INITIAL_ALPHA;
  }, [nodes, dimensions.width, dimensions.height]);

  // Run simulation loop
  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      alphaRef.current = tick(
        simNodesRef.current,
        edges,
        dimensions.width,
        dimensions.height,
        alphaRef.current,
      );
      setRenderTick((t) => t + 1);
      if (alphaRef.current > MIN_ALPHA) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [edges, dimensions.width, dimensions.height]);

  // Connected nodes for highlighting
  const connectedTo = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!map.has(e.source)) map.set(e.source, new Set());
      if (!map.has(e.target)) map.set(e.target, new Set());
      map.get(e.source)!.add(e.target);
      map.get(e.target)!.add(e.source);
    }
    return map;
  }, [edges]);

  const activeId = selectedNodeId ?? hoveredNodeId;
  const activeNeighbors = activeId ? connectedTo.get(activeId) : null;

  const isHighlighted = useCallback(
    (nodeId: string) => {
      if (!activeId) return true;
      return nodeId === activeId || (activeNeighbors?.has(nodeId) ?? false);
    },
    [activeId, activeNeighbors],
  );

  const isEdgeHighlighted = useCallback(
    (e: GraphEdge) => {
      if (!activeId) return false;
      return e.source === activeId || e.target === activeId;
    },
    [activeId],
  );

  // Drag handlers
  const handlePointerDown = useCallback(
    (e: React.PointerEvent, nodeId: string) => {
      e.preventDefault();
      (e.target as Element).setPointerCapture(e.pointerId);
      dragRef.current = { nodeId, wasDragged: false };
      const node = simNodesRef.current.find((n) => n.id === nodeId);
      if (node) {
        node.fx = node.x;
        node.fy = node.y;
      }
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current.nodeId) return;
      dragRef.current.wasDragged = true;

      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const node = simNodesRef.current.find(
        (n) => n.id === dragRef.current.nodeId,
      );
      if (node) {
        node.fx = x;
        node.fy = y;
        // Re-energize simulation
        alphaRef.current = Math.max(alphaRef.current, 0.3);
      }
    },
    [],
  );

  const handlePointerUp = useCallback(() => {
    if (dragRef.current.nodeId) {
      const node = simNodesRef.current.find(
        (n) => n.id === dragRef.current.nodeId,
      );
      if (node) {
        node.fx = undefined;
        node.fy = undefined;
      }
      // If it was a click (not drag), toggle selection
      if (!dragRef.current.wasDragged) {
        setSelectedNodeId((prev) =>
          prev === dragRef.current.nodeId ? null : dragRef.current.nodeId,
        );
      }
    }
    dragRef.current = { nodeId: null, wasDragged: false };
  }, []);

  // Hover tooltip
  const hoveredNode = hoveredNodeId
    ? simNodesRef.current.find((n) => n.id === hoveredNodeId)
    : null;

  // Suppress the "renderTick is unused" by reading it
  void renderTick;

  const simNodes = simNodesRef.current;
  const nodeMap = new Map(simNodes.map((n) => [n.id, n]));

  return (
    <div ref={containerRef} className="w-full">
      {/* Legend */}
      <div className="flex items-center gap-6 mb-3 text-sm text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <svg width="16" height="16">
            <circle cx="8" cy="8" r="6" fill={PERSON_FILL} />
          </svg>
          <span>Person</span>
        </div>
        <div className="flex items-center gap-1.5">
          <svg width="16" height="16">
            <rect x="2" y="2" width="12" height="12" rx="2" fill={ORG_FILL} />
          </svg>
          <span>Organization</span>
        </div>
        <div className="text-xs">
          Click a node to highlight connections. Drag to reposition.
        </div>
      </div>

      <div className="relative border rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-900">
        <svg
          ref={svgRef}
          width={dimensions.width}
          height={dimensions.height}
          viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
          className="select-none"
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
          {/* Edges */}
          <g>
            {edges.map((e, i) => {
              const s = nodeMap.get(e.source);
              const t = nodeMap.get(e.target);
              if (!s || !t) return null;
              const highlighted = isEdgeHighlighted(e);
              return (
                <line
                  key={`${e.source}-${e.target}-${i}`}
                  x1={s.x}
                  y1={s.y}
                  x2={t.x}
                  y2={t.y}
                  stroke={highlighted ? EDGE_STROKE_HIGHLIGHT : EDGE_STROKE}
                  strokeWidth={highlighted ? 2 : 1}
                  opacity={activeId && !highlighted ? 0.15 : highlighted ? 0.9 : 0.4}
                />
              );
            })}
          </g>

          {/* Nodes */}
          <g>
            {simNodes.map((node) => {
              const highlighted = isHighlighted(node.id);
              const isActive = node.id === activeId;
              const opacity = activeId && !highlighted ? 0.2 : 1;
              const fill =
                node.type === "person"
                  ? isActive
                    ? PERSON_FILL_HIGHLIGHT
                    : PERSON_FILL
                  : isActive
                    ? ORG_FILL_HIGHLIGHT
                    : ORG_FILL;

              return (
                <g
                  key={node.id}
                  className="cursor-pointer"
                  opacity={opacity}
                  onPointerDown={(e) => handlePointerDown(e, node.id)}
                  onPointerEnter={(e) => {
                    setHoveredNodeId(node.id);
                    setMousePos({ x: e.clientX, y: e.clientY });
                  }}
                  onPointerLeave={() => {
                    setHoveredNodeId(null);
                    setMousePos(null);
                  }}
                >
                  {node.type === "person" ? (
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={isActive ? PERSON_RADIUS + 2 : PERSON_RADIUS}
                      fill={fill}
                      stroke={isActive ? "#4338ca" : "white"}
                      strokeWidth={isActive ? 2.5 : 1.5}
                    />
                  ) : (
                    <rect
                      x={
                        node.x -
                        (isActive ? (ORG_SIZE + 2) : ORG_SIZE) / 2
                      }
                      y={
                        node.y -
                        (isActive ? (ORG_SIZE + 2) : ORG_SIZE) / 2
                      }
                      width={isActive ? ORG_SIZE + 2 : ORG_SIZE}
                      height={isActive ? ORG_SIZE + 2 : ORG_SIZE}
                      rx={2}
                      fill={fill}
                      stroke={isActive ? "#b45309" : "white"}
                      strokeWidth={isActive ? 2.5 : 1.5}
                    />
                  )}
                  {/* Label */}
                  <text
                    x={node.x}
                    y={
                      node.y +
                      (node.type === "person"
                        ? PERSON_RADIUS + 12
                        : ORG_SIZE / 2 + 12)
                    }
                    textAnchor="middle"
                    fill={TEXT_FILL}
                    className="dark:fill-gray-300"
                    fontSize={isActive ? 11 : 10}
                    fontWeight={isActive ? 600 : 400}
                    pointerEvents="none"
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>

        {/* Tooltip */}
        {hoveredNode && mousePos && (
          <div
            className="fixed z-50 pointer-events-none px-3 py-2 rounded-md shadow-lg text-sm"
            style={{
              left: mousePos.x + 12,
              top: mousePos.y - 10,
              backgroundColor: TOOLTIP_BG,
              color: TOOLTIP_TEXT,
              maxWidth: 280,
            }}
          >
            <div className="font-semibold">{hoveredNode.label}</div>
            <div className="text-xs opacity-80 capitalize">
              {hoveredNode.type}
            </div>
            {hoveredNode.detail && (
              <div className="text-xs mt-1 opacity-90">{hoveredNode.detail}</div>
            )}
            <div className="text-xs mt-1 opacity-60">
              {connectedTo.get(hoveredNode.id)?.size ?? 0} connections
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
