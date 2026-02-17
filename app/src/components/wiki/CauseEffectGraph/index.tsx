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
import { computeCausalPath } from './graph-algorithms';
import { toYaml, generateMermaidCode } from './graph-export';
import { getStyledEdges, getStyledNodes } from './styled-elements';

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
  const [layoutError, setLayoutError] = useState<string | null>(null);
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
    setLayoutError(null);
    getLayoutedElements(initialNodes, initialEdges, graphConfig).then(({ nodes: layoutedNodes, edges: layoutedEdges }) => {
      setNodes(layoutedNodes);
      setEdges(layoutedEdges);
      setIsLayouting(false);
    }).catch((error) => {
      console.error('Layout failed:', error);
      // Fall back to unpositioned nodes so the graph is still usable
      setNodes(initialNodes);
      setEdges(initialEdges);
      setLayoutError('Layout computation failed. Showing unpositioned graph.');
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
  const styledEdges = useMemo(
    () => getStyledEdges({ edges, hoveredNodeId, hoveredEdgeId, pathHighlight }),
    [edges, hoveredNodeId, hoveredEdgeId, pathHighlight]
  );

  // Style nodes based on hover state, selection, path highlighting, and score highlighting
  const styledNodes = useMemo(
    () => getStyledNodes({
      nodes, hoveredNodeId, connectedNodeIds, selectedNodeId,
      pathHighlight, pathHighlightNodeId, scoreHighlight, showScores,
    }),
    [nodes, hoveredNodeId, connectedNodeIds, selectedNodeId, pathHighlight, pathHighlightNodeId, scoreHighlight, showScores]
  );

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
            {layoutError && <div className="cause-effect-graph__loading" style={{ color: '#b45309', backgroundColor: '#fef3c7' }}>{layoutError}</div>}
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
