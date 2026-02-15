"use client";

import {
  useRef,
  useEffect,
  useState,
  useCallback,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type D3ZoomEvent } from "d3-zoom";
import type {
  SimilarityNode,
  SimilarityEdge,
  SimilarityGraphData,
} from "./get-similarity-data";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SimNode extends SimulationNodeDatum {
  id: string;
  title: string;
  entityType: string;
  color: string;
  importance: number;
  quality: number;
  radius: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  score: number;
}

interface Props {
  data: SimilarityGraphData;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_RADIUS = 3;
const MAX_RADIUS = 14;
const DEFAULT_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SimilarityGraph({ data }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(
    null
  );
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const transformRef = useRef(zoomIdentity);
  const hoveredRef = useRef<SimNode | null>(null);
  const dragNodeRef = useRef<SimNode | null>(null);

  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [hoveredNode, setHoveredNode] = useState<SimNode | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(
    new Set(data.entityTypes.map((t) => t.type))
  );
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Stats
  const visibleNodes = nodesRef.current.filter((n) =>
    selectedTypes.has(n.entityType)
  );
  const visibleEdges = linksRef.current.filter(
    (l) =>
      l.score >= threshold &&
      selectedTypes.has((l.source as SimNode).entityType) &&
      selectedTypes.has((l.target as SimNode).entityType)
  );

  // -----------------------------------------------------------------------
  // Resize observer
  // -----------------------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width, height });
        }
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // -----------------------------------------------------------------------
  // Build simulation
  // -----------------------------------------------------------------------

  useEffect(() => {
    const nodes: SimNode[] = data.nodes.map((n) => ({
      ...n,
      radius:
        MIN_RADIUS +
        ((n.importance ?? 50) / 100) * (MAX_RADIUS - MIN_RADIUS),
    }));

    const nodeIndex = new Map(nodes.map((n) => [n.id, n]));

    const links: SimLink[] = data.edges
      .filter((e) => nodeIndex.has(e.source) && nodeIndex.has(e.target))
      .map((e) => ({
        source: nodeIndex.get(e.source)!,
        target: nodeIndex.get(e.target)!,
        score: e.score,
      }));

    nodesRef.current = nodes;
    linksRef.current = links;

    const sim = forceSimulation<SimNode>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((d) => Math.max(30, 120 - d.score * 2))
          .strength((d) => Math.min(0.3, d.score / 50))
      )
      .force("charge", forceManyBody().strength(-30).distanceMax(300))
      .force(
        "center",
        forceCenter(dimensions.width / 2, dimensions.height / 2)
      )
      .force(
        "collide",
        forceCollide<SimNode>((d) => d.radius + 1).iterations(2)
      )
      .alphaDecay(0.02)
      .on("tick", () => draw());

    simRef.current = sim;

    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Update center force when dimensions change
  useEffect(() => {
    simRef.current
      ?.force(
        "center",
        forceCenter(dimensions.width / 2, dimensions.height / 2)
      )
      .alpha(0.1)
      .restart();
  }, [dimensions]);

  // -----------------------------------------------------------------------
  // Canvas draw
  // -----------------------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = dimensions;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const t = transformRef.current;
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    const nodes = nodesRef.current;
    const links = linksRef.current;
    const hovered = hoveredRef.current;
    const connectedIds = new Set<string>();

    if (hovered) {
      for (const l of links) {
        const s = l.source as SimNode;
        const tgt = l.target as SimNode;
        if (
          l.score >= threshold &&
          (s.id === hovered.id || tgt.id === hovered.id)
        ) {
          connectedIds.add(s.id);
          connectedIds.add(tgt.id);
        }
      }
    }

    // Draw edges
    for (const l of links) {
      const s = l.source as SimNode;
      const tgt = l.target as SimNode;
      if (l.score < threshold) continue;
      if (!selectedTypes.has(s.entityType) || !selectedTypes.has(tgt.entityType))
        continue;
      if (s.x == null || s.y == null || tgt.x == null || tgt.y == null)
        continue;

      const isHighlighted =
        hovered && (s.id === hovered.id || tgt.id === hovered.id);
      const opacity = hovered ? (isHighlighted ? 0.6 : 0.03) : 0.12;
      const lineWidth = isHighlighted
        ? 1.5
        : Math.max(0.3, Math.min(1, l.score / 20));

      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(tgt.x, tgt.y);
      ctx.strokeStyle = isHighlighted
        ? hovered!.color
        : `rgba(150, 150, 150, ${opacity})`;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }

    // Draw nodes
    for (const n of nodes) {
      if (!selectedTypes.has(n.entityType)) continue;
      if (n.x == null || n.y == null) continue;

      const dimmed =
        hovered && n.id !== hovered.id && !connectedIds.has(n.id);
      const alpha = dimmed ? 0.15 : 1;

      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = dimmed
        ? `rgba(180, 180, 180, ${alpha})`
        : n.color;
      ctx.fill();

      if (n.id === hovered?.id) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Draw hovered label
    if (hovered && hovered.x != null && hovered.y != null) {
      const label = hovered.title;
      ctx.font = "bold 12px system-ui, sans-serif";
      const metrics = ctx.measureText(label);
      const pad = 4;
      const lx = hovered.x + hovered.radius + 6;
      const ly = hovered.y - 6;

      ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
      ctx.beginPath();
      ctx.roundRect(
        lx - pad,
        ly - 12 - pad,
        metrics.width + pad * 2,
        16 + pad * 2,
        4
      );
      ctx.fill();

      ctx.fillStyle = "#fff";
      ctx.fillText(label, lx, ly);
    }

    ctx.restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimensions, threshold, selectedTypes]);

  // Redraw when filters change
  useEffect(() => {
    draw();
  }, [draw]);

  // -----------------------------------------------------------------------
  // Zoom
  // -----------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const zoomBehavior = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.1, 8])
      .on("zoom", (event: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        transformRef.current = event.transform;
        draw();
      });

    select(canvas).call(zoomBehavior);

    return () => {
      select(canvas).on(".zoom", null);
    };
  }, [draw]);

  // -----------------------------------------------------------------------
  // Mouse interactions
  // -----------------------------------------------------------------------

  const findNodeAt = useCallback(
    (clientX: number, clientY: number): SimNode | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const t = transformRef.current;
      const x = (clientX - rect.left - t.x) / t.k;
      const y = (clientY - rect.top - t.y) / t.k;

      for (const n of nodesRef.current) {
        if (!selectedTypes.has(n.entityType)) continue;
        if (n.x == null || n.y == null) continue;
        const dx = x - n.x;
        const dy = y - n.y;
        if (dx * dx + dy * dy < (n.radius + 4) * (n.radius + 4)) {
          return n;
        }
      }
      return null;
    },
    [selectedTypes]
  );

  const handleMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      if (dragNodeRef.current) {
        // Dragging
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const t = transformRef.current;
        dragNodeRef.current.fx = (e.clientX - rect.left - t.x) / t.k;
        dragNodeRef.current.fy = (e.clientY - rect.top - t.y) / t.k;
        simRef.current?.alpha(0.3).restart();
        return;
      }

      const node = findNodeAt(e.clientX, e.clientY);
      hoveredRef.current = node;
      setHoveredNode(node);
      draw();

      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = node ? "pointer" : "grab";
    },
    [findNodeAt, draw]
  );

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      const node = findNodeAt(e.clientX, e.clientY);
      if (node) {
        e.preventDefault();
        e.stopPropagation();
        dragNodeRef.current = node;
        node.fx = node.x;
        node.fy = node.y;
        simRef.current?.alphaTarget(0.3).restart();
      }
    },
    [findNodeAt]
  );

  const handleMouseUp = useCallback(() => {
    if (dragNodeRef.current) {
      dragNodeRef.current.fx = null;
      dragNodeRef.current.fy = null;
      dragNodeRef.current = null;
      simRef.current?.alphaTarget(0);
    }
  }, []);

  const handleClick = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      if (dragNodeRef.current) return;
      const node = findNodeAt(e.clientX, e.clientY);
      if (node) {
        window.open(`/wiki/${node.id}`, "_blank");
      }
    },
    [findNodeAt]
  );

  // -----------------------------------------------------------------------
  // Type filter toggle
  // -----------------------------------------------------------------------

  const toggleType = (type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const selectAll = () =>
    setSelectedTypes(new Set(data.entityTypes.map((t) => t.type)));
  const selectNone = () => setSelectedTypes(new Set());

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4">
      {/* Controls */}
      <div className="flex flex-wrap items-start gap-6 rounded-lg border bg-muted/30 p-4">
        {/* Threshold slider */}
        <div className="flex flex-col gap-1 min-w-48">
          <label className="text-sm font-medium">
            Min similarity score: {threshold}
          </label>
          <input
            type="range"
            min={1}
            max={30}
            step={1}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>1 (more edges)</span>
            <span>30 (fewer edges)</span>
          </div>
        </div>

        {/* Stats */}
        <div className="text-sm text-muted-foreground space-y-1">
          <div>
            <strong>{visibleNodes.length}</strong> pages
          </div>
          <div>
            <strong>{visibleEdges.length}</strong> connections
          </div>
          {hoveredNode && (
            <div className="text-foreground mt-1">
              <strong>{hoveredNode.title}</strong>
              <br />
              <span className="text-xs">
                importance: {hoveredNode.importance} | quality:{" "}
                {hoveredNode.quality}
              </span>
            </div>
          )}
        </div>

        {/* Type filters */}
        <div className="flex-1 min-w-64">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium">Entity types</span>
            <button
              onClick={selectAll}
              className="text-xs underline text-muted-foreground hover:text-foreground"
            >
              all
            </button>
            <button
              onClick={selectNone}
              className="text-xs underline text-muted-foreground hover:text-foreground"
            >
              none
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.entityTypes.map((t) => (
              <button
                key={t.type}
                onClick={() => toggleType(t.type)}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-opacity ${
                  selectedTypes.has(t.type) ? "opacity-100" : "opacity-30"
                }`}
                style={{
                  backgroundColor: `${t.color}20`,
                  color: t.color,
                  border: `1px solid ${t.color}40`,
                }}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: t.color }}
                />
                {t.label} ({t.count})
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Graph canvas */}
      <div
        ref={containerRef}
        className="relative w-full rounded-lg border bg-background"
        style={{ height: "calc(100vh - 280px)", minHeight: 400 }}
      >
        <canvas
          ref={canvasRef}
          width={dimensions.width}
          height={dimensions.height}
          style={{ width: "100%", height: "100%", cursor: "grab" }}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleClick}
        />
        <div className="absolute bottom-3 left-3 text-xs text-muted-foreground bg-background/80 rounded px-2 py-1">
          Drag to pan, scroll to zoom, hover for details, click to open page
        </div>
      </div>
    </div>
  );
}
