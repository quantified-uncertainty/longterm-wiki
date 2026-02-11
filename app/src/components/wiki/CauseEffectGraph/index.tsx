"use client";

import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
  addEdge,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
  type NodeMouseHandler,
  type EdgeMouseHandler,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './CauseEffectGraph.css';

import type { CauseEffectNodeData, CauseEffectEdgeData, GraphConfig } from './types';
import { GroupNode, SubgroupNode, CauseEffectNode } from './nodes';
import { Legend, DataView, CopyIcon, CheckIcon, ExpandIcon, ShrinkIcon } from './components';
import { getLayoutedElements } from './layout';
import { ZoomProvider } from './ZoomContext';
import { MermaidDiagram } from '@/components/wiki/MermaidDiagram';

// Re-export types for external use
export type { CauseEffectNodeData, CauseEffectEdgeData, GraphConfig, LayoutOptions, TypeLabels, SubgroupConfig, LegendItem, LayoutAlgorithm } from './types';

const nodeTypes = {
  causeEffect: CauseEffectNode,
  group: GroupNode,
  subgroup: SubgroupNode,
};

// Score dimension keys that can be used for highlighting
export type ScoreHighlightMode = 'novelty' | 'sensitivity' | 'changeability' | 'certainty';

interface CauseEffectGraphProps {
  initialNodes: Node<CauseEffectNodeData>[];
  initialEdges: Edge<CauseEffectEdgeData>[];
  height?: string | number;
  fitViewPadding?: number;
  graphConfig?: GraphConfig;
  showFullscreenButton?: boolean;
  hideListView?: boolean;  // Hide the "List View" tab link
  selectedNodeId?: string;  // ID of node to highlight as selected (e.g., the current page's node)
  minZoom?: number;  // Minimum zoom level (default 0.1 for large graphs)
  maxZoom?: number;  // Maximum zoom level (default 2)
  defaultZoom?: number;  // Initial zoom level (if not specified, fitView is used)
  showMiniMap?: boolean;  // Show mini-map navigation (default false)
  enablePathHighlighting?: boolean;  // Click nodes to highlight causal paths (default false)
  entityId?: string;  // Entity ID for linking to expanded diagram page
  showDescriptions?: boolean;  // Show descriptions on nodes (default true)
  showScores?: boolean;  // Show score indicators on nodes (default false)
  renderHeaderRight?: () => React.ReactNode;  // Custom content for right side of header
  scoreHighlight?: ScoreHighlightMode;  // Highlight nodes by score dimension (opacity based on score value)
  onNodeClick?: (node: Node<CauseEffectNodeData>) => void;  // External callback when a node is clicked
}

// Generate YAML representation of graph data
function toYaml(nodes: Node<CauseEffectNodeData>[], edges: Edge<CauseEffectEdgeData>[]): string {
  const edgesBySource = new Map<string, Edge<CauseEffectEdgeData>[]>();
  for (const edge of edges) {
    if (!edgesBySource.has(edge.source)) {
      edgesBySource.set(edge.source, []);
    }
    edgesBySource.get(edge.source)!.push(edge);
  }

  const lines: string[] = ['nodes:'];

  for (const node of nodes) {
    lines.push(`  - id: ${node.id}`);
    lines.push(`    label: "${node.data.label}"`);
    if (node.data.type) lines.push(`    type: ${node.data.type}`);
    if (node.data.confidence !== undefined) lines.push(`    confidence: ${node.data.confidence}`);
    if (node.data.confidenceLabel) lines.push(`    confidenceLabel: "${node.data.confidenceLabel}"`);
    if (node.data.description) lines.push(`    description: "${node.data.description.replace(/"/g, '\\"')}"`);
    if (node.data.details) lines.push(`    details: "${node.data.details.replace(/"/g, '\\"')}"`);
    if (node.data.relatedConcepts?.length) {
      lines.push(`    relatedConcepts:`);
      for (const concept of node.data.relatedConcepts) lines.push(`      - "${concept}"`);
    }
    if (node.data.sources?.length) {
      lines.push(`    sources:`);
      for (const source of node.data.sources) lines.push(`      - "${source}"`);
    }
    if (node.data.scores) {
      const { novelty, sensitivity, changeability, certainty } = node.data.scores;
      if (novelty !== undefined || sensitivity !== undefined || changeability !== undefined || certainty !== undefined) {
        lines.push(`    scores:`);
        if (novelty !== undefined) lines.push(`      novelty: ${novelty}`);
        if (sensitivity !== undefined) lines.push(`      sensitivity: ${sensitivity}`);
        if (changeability !== undefined) lines.push(`      changeability: ${changeability}`);
        if (certainty !== undefined) lines.push(`      certainty: ${certainty}`);
      }
    }
    const nodeEdges = edgesBySource.get(node.id);
    if (nodeEdges?.length) {
      lines.push(`    edges:`);
      for (const edge of nodeEdges) {
        lines.push(`      - target: ${edge.target}`);
        if (edge.data?.strength) lines.push(`        strength: ${edge.data.strength}`);
        if (edge.data?.confidence) lines.push(`        confidence: ${edge.data.confidence}`);
        if (edge.data?.effect) lines.push(`        effect: ${edge.data.effect}`);
        if (edge.data?.label) lines.push(`        label: "${edge.data.label}"`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// Unified graph traversal function for computing node/edge neighborhoods
// - 'directed': Traverses upstream and downstream separately (for causal paths)
// - 'undirected': Treats edges as bidirectional (for local neighborhood)
function traverseGraph(
  startNodeId: string,
  edges: Edge<CauseEffectEdgeData>[],
  depth: number,
  mode: 'directed' | 'undirected'
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeIds = new Set<string>([startNodeId]);
  const edgeIds = new Set<string>();

  // Build adjacency maps based on mode
  const adjacencyMaps: Map<string, { nodeId: string; edgeId: string }[]>[] = [];

  if (mode === 'directed') {
    // Separate maps for downstream and upstream traversal
    const downstream = new Map<string, { nodeId: string; edgeId: string }[]>();
    const upstream = new Map<string, { nodeId: string; edgeId: string }[]>();

    for (const edge of edges) {
      if (!downstream.has(edge.source)) downstream.set(edge.source, []);
      downstream.get(edge.source)!.push({ nodeId: edge.target, edgeId: edge.id });

      if (!upstream.has(edge.target)) upstream.set(edge.target, []);
      upstream.get(edge.target)!.push({ nodeId: edge.source, edgeId: edge.id });
    }
    adjacencyMaps.push(downstream, upstream);
  } else {
    // Single bidirectional map
    const neighbors = new Map<string, { nodeId: string; edgeId: string }[]>();

    for (const edge of edges) {
      if (!neighbors.has(edge.source)) neighbors.set(edge.source, []);
      neighbors.get(edge.source)!.push({ nodeId: edge.target, edgeId: edge.id });

      if (!neighbors.has(edge.target)) neighbors.set(edge.target, []);
      neighbors.get(edge.target)!.push({ nodeId: edge.source, edgeId: edge.id });
    }
    adjacencyMaps.push(neighbors);
  }

  // BFS traversal for each adjacency map
  for (const adjacency of adjacencyMaps) {
    let frontier = new Set([startNodeId]);
    for (let d = 0; d < depth && frontier.size > 0; d++) {
      const nextFrontier = new Set<string>();
      for (const nodeId of frontier) {
        for (const { nodeId: nextId, edgeId } of adjacency.get(nodeId) || []) {
          edgeIds.add(edgeId);
          if (!nodeIds.has(nextId)) {
            nodeIds.add(nextId);
            nextFrontier.add(nextId);
          }
        }
      }
      frontier = nextFrontier;
    }
  }

  return { nodeIds, edgeIds };
}

// Convenience wrapper for causal path computation
const computeCausalPath = (startNodeId: string, edges: Edge<CauseEffectEdgeData>[], maxDepth = 10) =>
  traverseGraph(startNodeId, edges, maxDepth, 'directed');

// Generate Mermaid flowchart syntax from graph data
function generateMermaidCode(nodes: Node<CauseEffectNodeData>[], edges: Edge<CauseEffectEdgeData>[], direction: 'TD' | 'LR' = 'TD'): string {
  const lines: string[] = [];
  lines.push(`flowchart ${direction}`);
  lines.push('');

  // Group nodes by type for subgraphs
  const nodesByType: Record<string, Node<CauseEffectNodeData>[]> = {};
  for (const node of nodes) {
    if (node.type === 'group' || node.type === 'subgroup' || node.type === 'clusterContainer') continue;
    const nodeType = node.data.type || 'intermediate';
    if (!nodesByType[nodeType]) nodesByType[nodeType] = [];
    nodesByType[nodeType].push(node);
  }

  // Type labels and order
  const typeLabels: Record<string, string> = {
    leaf: 'Root Causes',
    cause: 'Derived Factors',
    intermediate: 'Direct Factors',
    effect: 'Outcomes',
  };
  const typeOrder = ['leaf', 'cause', 'intermediate', 'effect'];

  // Add nodes grouped by type
  for (const nodeType of typeOrder) {
    const typeNodes = nodesByType[nodeType];
    if (!typeNodes || typeNodes.length === 0) continue;

    const label = typeLabels[nodeType] || nodeType;
    lines.push(`    subgraph ${nodeType}["${label}"]`);
    for (const node of typeNodes) {
      // Escape quotes and special chars in labels
      const safeLabel = (node.data.label || node.id).replace(/"/g, "'").replace(/\[/g, '(').replace(/\]/g, ')');
      // Use different shapes based on type
      // Effect: stadium shape (rounded sides)
      // All others: rectangle
      if (nodeType === 'effect') {
        lines.push(`        ${node.id}(["${safeLabel}"])`);
      } else {
        lines.push(`        ${node.id}["${safeLabel}"]`);
      }
    }
    lines.push('    end');
    lines.push('');
  }

  // Add edges
  lines.push('    %% Edges');
  for (const edge of edges) {
    const edgeData = edge.data;
    const arrowType = edgeData?.effect === 'decreases' ? '-.->|−|' :
                      edgeData?.effect === 'mixed' ? '-.->|±|' :
                      edgeData?.strength === 'strong' ? '==>' : '-->';
    lines.push(`    ${edge.source} ${arrowType} ${edge.target}`);
  }

  // Add styling
  lines.push('');
  lines.push('    %% Styling');
  lines.push('    classDef leaf fill:#f0fdfa,stroke:#14b8a6,stroke-width:2px');
  lines.push('    classDef cause fill:#eff6ff,stroke:#3b82f6,stroke-width:2px');
  lines.push('    classDef intermediate fill:#f8fafc,stroke:#64748b,stroke-width:2px');
  lines.push('    classDef effect fill:#fffbeb,stroke:#f59e0b,stroke-width:2px');

  // Apply classes to nodes
  for (const nodeType of typeOrder) {
    const typeNodes = nodesByType[nodeType];
    if (typeNodes && typeNodes.length > 0) {
      lines.push(`    class ${typeNodes.map(n => n.id).join(',')} ${nodeType}`);
    }
  }

  return lines.join('\n');
}

// Inner component that has access to ReactFlow instance
function CauseEffectGraphInner({
  initialNodes,
  initialEdges,
  height = 500,
  fitViewPadding = 0.1,
  graphConfig,
  showFullscreenButton = true,
  hideListView = false,
  selectedNodeId,
  minZoom = 0.1,
  maxZoom = 2,
  defaultZoom,
  showMiniMap = false,
  enablePathHighlighting = false,
  entityId,
  showDescriptions = true,
  showScores = false,
  renderHeaderRight,
  scoreHighlight,
  onNodeClick: onNodeClickExternal,
}: CauseEffectGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CauseEffectNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<CauseEffectEdgeData>>([]);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [pathHighlightNodeId, setPathHighlightNodeId] = useState<string | null>(null);
  const [isLayouting, setIsLayouting] = useState(true);
  const [currentZoom, setCurrentZoom] = useState(1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reactFlowInstance = useRef<ReactFlowInstance<any, any> | null>(null);

  // Track zoom level changes for semantic zoom
  // Zoom levels: far (<0.25), medium (0.25-0.5), close (0.5-0.9), detail (>0.9)
  const onViewportChange = useCallback((viewport: Viewport) => {
    setCurrentZoom(viewport.zoom);
  }, []);

  // Compute zoom level class for CSS-based semantic zoom
  const zoomLevelClass = useMemo(() => {
    if (currentZoom < 0.25) return 'ceg-zoom-far';
    if (currentZoom < 0.5) return 'ceg-zoom-medium';
    if (currentZoom < 0.9) return 'ceg-zoom-close';
    return 'ceg-zoom-detail';
  }, [currentZoom]);

  // Fit view handler for the "Fit All" button
  const handleFitView = useCallback(() => {
    if (reactFlowInstance.current) {
      reactFlowInstance.current.fitView({ padding: fitViewPadding, duration: 300 });
    }
  }, [fitViewPadding]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [activeTab, setActiveTab] = useState<'graph' | 'mermaid' | 'data'>('graph');
  const [copied, setCopied] = useState(false);
  const [mermaidCopied, setMermaidCopied] = useState(false);
  const [mermaidDirection, setMermaidDirection] = useState<'TD' | 'LR'>('TD');

  const yamlData = toYaml(initialNodes, initialEdges);
  const mermaidCode = useMemo(() => generateMermaidCode(initialNodes, initialEdges, mermaidDirection), [initialNodes, initialEdges, mermaidDirection]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(yamlData);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleMermaidCopy = async () => {
    try {
      await navigator.clipboard.writeText(mermaidCode);
      setMermaidCopied(true);
      setTimeout(() => setMermaidCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Layout effect - uses JSON stringify to ensure deep comparison of graphConfig
  const graphConfigKey = JSON.stringify(graphConfig);
  useEffect(() => {
    setIsLayouting(true);
    getLayoutedElements(initialNodes, initialEdges, graphConfig).then(({ nodes: layoutedNodes, edges: layoutedEdges }) => {
      setNodes(layoutedNodes);
      setEdges(layoutedEdges);
      setIsLayouting(false);
    }).catch((error) => {
      console.error('Layout failed:', error);
      setIsLayouting(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialNodes, initialEdges, graphConfigKey, setNodes, setEdges]);

  // Event handlers
  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges]
  );

  const toggleFullscreen = useCallback(() => setIsFullscreen((prev) => !prev), []);

  const onNodeMouseEnter: NodeMouseHandler<Node<CauseEffectNodeData>> = useCallback(
    (_, node) => setHoveredNodeId(node.id),
    []
  );

  const onNodeMouseLeave = useCallback(() => setHoveredNodeId(null), []);

  // Edge hover handlers for showing labels
  const onEdgeMouseEnter: EdgeMouseHandler<Edge<CauseEffectEdgeData>> = useCallback(
    (_, edge) => setHoveredEdgeId(edge.id),
    []
  );

  const onEdgeMouseLeave = useCallback(() => setHoveredEdgeId(null), []);

  // Node click handler for path highlighting and external callback
  const onNodeClick: NodeMouseHandler<Node<CauseEffectNodeData>> = useCallback(
    (event, node) => {
      onNodeClickExternal?.(node);
      if (!enablePathHighlighting) return;
      // Toggle: if clicking same node, clear; otherwise set new
      setPathHighlightNodeId((prev) => (prev === node.id ? null : node.id));
    },
    [enablePathHighlighting, onNodeClickExternal]
  );

  // Compute path highlight data
  const pathHighlight = useMemo(() => {
    if (!pathHighlightNodeId || !enablePathHighlighting) {
      return { nodeIds: new Set<string>(), edgeIds: new Set<string>() };
    }
    return computeCausalPath(pathHighlightNodeId, edges);
  }, [pathHighlightNodeId, edges, enablePathHighlighting]);

  // Compute connected nodes for hover highlighting
  const connectedNodeIds = useMemo(() => {
    if (!hoveredNodeId) return new Set<string>();
    const connected = new Set<string>([hoveredNodeId]);
    edges.forEach((edge) => {
      if (edge.source === hoveredNodeId) connected.add(edge.target);
      if (edge.target === hoveredNodeId) connected.add(edge.source);
    });
    return connected;
  }, [hoveredNodeId, edges]);

  // Style edges based on hover, path highlighting, and edge hover states
  const styledEdges = useMemo(() => {
    return edges.map((edge) => {
      const isHoveredEdge = hoveredEdgeId === edge.id;
      const isConnectedToHoveredNode = edge.source === hoveredNodeId || edge.target === hoveredNodeId;
      const isInPath = pathHighlight.edgeIds.has(edge.id);
      const hasPathHighlight = pathHighlight.nodeIds.size > 0;
      const hasHoveredNode = !!hoveredNodeId;

      // Determine if this edge should be highlighted
      const isHighlighted = isHoveredEdge || isConnectedToHoveredNode || isInPath;

      // Determine opacity based on state
      let opacity = 1;
      if (hasPathHighlight && !isInPath) {
        opacity = 0.15;
      } else if (hasHoveredNode && !isConnectedToHoveredNode) {
        opacity = 0.15;
      }

      // Show label on hover
      const edgeData = edge.data as CauseEffectEdgeData | undefined;
      const showLabel = isHoveredEdge && edgeData;
      const effectLabel = edgeData?.effect === 'decreases' ? '−' : edgeData?.effect === 'mixed' ? '±' : '+';
      const strengthLabel = edgeData?.strength === 'strong' ? 'Strong' : edgeData?.strength === 'weak' ? 'Weak' : '';

      return {
        ...edge,
        label: showLabel ? `${strengthLabel} ${effectLabel}`.trim() : undefined,
        labelStyle: showLabel ? {
          fill: '#f1f5f9',
          fontSize: 11,
          fontWeight: 500,
        } : undefined,
        labelBgStyle: showLabel ? {
          fill: edgeData?.effect === 'decreases' ? '#991b1b' : edgeData?.effect === 'mixed' ? '#854d0e' : '#166534',
          fillOpacity: 1,
        } : undefined,
        labelBgPadding: [4, 6] as [number, number],
        labelBgBorderRadius: 4,
        style: {
          ...edge.style,
          opacity,
          strokeWidth: isHighlighted
            ? ((edge.style?.strokeWidth as number) || 2) * 1.5
            : edge.style?.strokeWidth,
        },
        markerEnd: isHighlighted
          ? edge.markerEnd
          : (typeof edge.markerEnd === 'object' ? { ...edge.markerEnd, color: '#d6d3d1' } : edge.markerEnd) as typeof edge.markerEnd,
        zIndex: isHighlighted ? 1000 : 0,
        className: isInPath ? 'react-flow__edge--path-highlighted' : undefined,
      };
    });
  }, [edges, hoveredNodeId, hoveredEdgeId, pathHighlight]);

  // Style nodes based on hover state, selection, path highlighting, and score highlighting
  const styledNodes = useMemo(() => {
    return nodes.map((node) => {
      if (node.type === 'group' || node.type === 'subgroup' || node.type === 'clusterContainer') return node;

      const isSelected = selectedNodeId === node.id;
      const isPathRoot = pathHighlightNodeId === node.id;
      const isInPath = pathHighlight.nodeIds.has(node.id);
      const hasPathHighlight = pathHighlight.nodeIds.size > 0;
      const isConnected = hoveredNodeId ? connectedNodeIds.has(node.id) : true;

      // Determine opacity and score-based styling
      let opacity = 1;
      let scoreIntensity: number | undefined;
      let highlightColor: 'purple' | 'red' | 'green' | 'blue' | 'yellow' | undefined;

      // Map score dimensions to highlight colors
      const scoreToColor: Record<string, 'purple' | 'red' | 'green' | 'blue'> = {
        novelty: 'purple',
        sensitivity: 'blue',
        changeability: 'green',
        certainty: 'red',
      };

      // Score-based highlighting takes precedence when active
      if (scoreHighlight && node.data.scores) {
        const score = node.data.scores[scoreHighlight];
        highlightColor = scoreToColor[scoreHighlight];
        if (score !== undefined) {
          // Normalize score to 0-1 range for color intensity
          scoreIntensity = (score - 1) / 9; // 0 for score 1, 1 for score 10
        } else {
          // No score for this dimension = very dimmed
          scoreIntensity = -1; // Signal "no score"
        }
      } else if (scoreHighlight) {
        // Score highlight mode active but node has no scores at all
        scoreIntensity = -1;
        highlightColor = scoreToColor[scoreHighlight];
      } else if (hasPathHighlight && !isInPath) {
        opacity = 0.3;
      } else if (hoveredNodeId && !isConnected) {
        opacity = 0.3;
      }

      return {
        ...node,
        selected: isSelected || isPathRoot,
        data: {
          ...node.data,
          // Pass score intensity to node for styling
          scoreIntensity,
          // Pass highlight color for score-based styling
          highlightColor,
          // Pass active score dimension for fading non-active scores
          activeScoreDimension: scoreHighlight,
          // Pass showScores setting to node
          showScores,
        },
        style: {
          ...node.style,
          opacity,
          zIndex: isInPath || isConnected ? 1001 : undefined,
        },
        className: isInPath ? 'react-flow__node--path-highlighted' : undefined,
      };
    });
  }, [nodes, hoveredNodeId, connectedNodeIds, selectedNodeId, pathHighlight, pathHighlightNodeId, scoreHighlight, showScores]);

  // Keyboard handler for ESC
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) setIsFullscreen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  // Fullscreen body handling
  useEffect(() => {
    document.body.style.overflow = isFullscreen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isFullscreen]);

  const containerClass = `cause-effect-graph ${isFullscreen ? 'cause-effect-graph--fullscreen' : ''} ${zoomLevelClass} ${!showDescriptions ? 'cause-effect-graph--hide-descriptions' : ''}`;

  // Build container style with CSS variables for configurable values
  const nodeWidth = graphConfig?.nodeWidth ?? 180;
  const containerStyle: React.CSSProperties = {
    ...(isFullscreen ? {} : { height }),
    '--ceg-node-width': `${nodeWidth}px`,
  } as React.CSSProperties;

  return (
    <div className={containerClass} style={containerStyle}>
      {/* Header */}
      <div className="ceg-header">
        <div className="ceg-segmented-control">
          <button
            className={`ceg-segment-btn ${activeTab === 'graph' ? 'ceg-segment-btn--active' : ''}`}
            onClick={() => setActiveTab('graph')}
          >
            Graph
          </button>
          <button
            className={`ceg-segment-btn ${activeTab === 'mermaid' ? 'ceg-segment-btn--active' : ''}`}
            onClick={() => setActiveTab('mermaid')}
          >
            Mermaid
          </button>
          <button
            className={`ceg-segment-btn ${activeTab === 'data' ? 'ceg-segment-btn--active' : ''}`}
            onClick={() => setActiveTab('data')}
          >
            Data (YAML)
          </button>
          {!hideListView && (
            <a
              href="/wiki/ai-transition-model"
              className="ceg-segment-btn ceg-segment-link"
            >
              List View
            </a>
          )}
        </div>

        <div className="ceg-button-group">
          {activeTab === 'graph' && (
            <button className="ceg-action-btn" onClick={handleFitView} title="Fit all nodes in view">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
              </svg>
              Fit All
            </button>
          )}
          {activeTab === 'mermaid' && (
            <>
              <button
                className="ceg-action-btn"
                onClick={() => setMermaidDirection(d => d === 'TD' ? 'LR' : 'TD')}
                title={mermaidDirection === 'TD' ? 'Switch to left-right layout' : 'Switch to top-down layout'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {mermaidDirection === 'TD' ? (
                    <path d="M12 3v18M5 12h14M5 12l4-4M5 12l4 4M19 12l-4-4M19 12l-4 4"/>
                  ) : (
                    <path d="M3 12h18M12 5v14M12 5l-4 4M12 5l4 4M12 19l-4-4M12 19l4-4"/>
                  )}
                </svg>
                {mermaidDirection === 'TD' ? 'Top→Down' : 'Left→Right'}
              </button>
              <button className="ceg-action-btn" onClick={handleMermaidCopy}>
                {mermaidCopied ? <CheckIcon /> : <CopyIcon />}
                {mermaidCopied ? 'Copied!' : 'Copy Code'}
              </button>
            </>
          )}
          {activeTab === 'data' && (
            <button className="ceg-action-btn" onClick={handleCopy}>
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? 'Copied!' : 'Copy'}
            </button>
          )}
          {showFullscreenButton && entityId && (
            <a href={`/wiki/${entityId}`} className="ceg-action-btn" style={{ textDecoration: 'none' }}>
              <ExpandIcon />
              Expand
            </a>
          )}
          {showFullscreenButton && !entityId && (
            <button className="ceg-action-btn" onClick={toggleFullscreen}>
              {isFullscreen ? <ShrinkIcon /> : <ExpandIcon />}
              {isFullscreen ? 'Exit' : 'Fullscreen'}
            </button>
          )}
          {renderHeaderRight && renderHeaderRight()}
        </div>
      </div>

      {/* Content */}
      <div className="ceg-content">
        {activeTab === 'graph' && (
          <div className="cause-effect-graph__content">
            {isLayouting && <div className="cause-effect-graph__loading">Computing layout...</div>}
            <ReactFlow
              nodes={styledNodes}
              edges={styledEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeMouseEnter={onNodeMouseEnter}
              onNodeMouseLeave={onNodeMouseLeave}
              onNodeClick={onNodeClick}
              onEdgeMouseEnter={onEdgeMouseEnter}
              onEdgeMouseLeave={onEdgeMouseLeave}
              onViewportChange={onViewportChange}
              nodeTypes={nodeTypes}
              fitView={!defaultZoom}
              fitViewOptions={{ padding: fitViewPadding }}
              minZoom={minZoom}
              maxZoom={maxZoom}
              defaultViewport={defaultZoom ? { x: 0, y: 0, zoom: defaultZoom } : undefined}
              onInit={(instance) => { reactFlowInstance.current = instance; }}
              defaultEdgeOptions={{
                type: graphConfig?.straightEdges ? 'straight' : 'default',
                style: { stroke: '#d6d3d1', strokeWidth: 1.5 },
                markerEnd: { type: MarkerType.Arrow, color: '#d6d3d1', width: 15, height: 15, strokeWidth: 2 },
              }}
            >
              <Controls />
              {showMiniMap && (
                <MiniMap
                  nodeStrokeWidth={3}
                  zoomable
                  pannable
                  style={{ width: 150, height: 100 }}
                />
              )}
            </ReactFlow>
            <Legend typeLabels={graphConfig?.typeLabels} customItems={graphConfig?.legendItems} />
          </div>
        )}
        {activeTab === 'mermaid' && (
          <div className="ceg-mermaid-view">
            <MermaidDiagram chart={mermaidCode} />
          </div>
        )}
        {activeTab === 'data' && <DataView yaml={yamlData} />}
      </div>
    </div>
  );
}

// Wrapper component that provides ReactFlow context
export default function CauseEffectGraph(props: CauseEffectGraphProps) {
  return (
    <ReactFlowProvider>
      <CauseEffectGraphInner {...props} />
    </ReactFlowProvider>
  );
}
