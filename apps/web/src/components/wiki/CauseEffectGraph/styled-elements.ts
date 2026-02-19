/**
 * Styled element utilities for CauseEffectGraph.
 *
 * Pure functions that compute styled nodes and edges based on hover state,
 * path highlighting, selection, and score highlighting.
 */

import type { Node, Edge } from '@xyflow/react';
import type { CauseEffectNodeData, CauseEffectEdgeData } from './types';
import type { ScoreHighlightMode } from './index';

// ── Styled Edges ─────────────────────────────────────────────────────────────

interface StyledEdgesInput {
  edges: Edge<CauseEffectEdgeData>[];
  hoveredNodeId: string | null;
  hoveredEdgeId: string | null;
  pathHighlight: { nodeIds: Set<string>; edgeIds: Set<string> };
}

/** Compute styled edges based on hover, path highlighting, and edge hover states. */
export function getStyledEdges({
  edges,
  hoveredNodeId,
  hoveredEdgeId,
  pathHighlight,
}: StyledEdgesInput): Edge<CauseEffectEdgeData>[] {
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
}

// ── Styled Nodes ─────────────────────────────────────────────────────────────

interface StyledNodesInput {
  nodes: Node<CauseEffectNodeData>[];
  hoveredNodeId: string | null;
  connectedNodeIds: Set<string>;
  selectedNodeId?: string;
  pathHighlight: { nodeIds: Set<string>; edgeIds: Set<string> };
  pathHighlightNodeId: string | null;
  scoreHighlight?: ScoreHighlightMode;
  showScores: boolean;
}

/** Map score dimensions to highlight colors. */
const SCORE_TO_COLOR: Record<string, 'purple' | 'red' | 'green' | 'blue'> = {
  novelty: 'purple',
  sensitivity: 'blue',
  changeability: 'green',
  certainty: 'red',
};

/** Compute styled nodes based on hover state, selection, path highlighting, and score highlighting. */
export function getStyledNodes({
  nodes,
  hoveredNodeId,
  connectedNodeIds,
  selectedNodeId,
  pathHighlight,
  pathHighlightNodeId,
  scoreHighlight,
  showScores,
}: StyledNodesInput): Node<CauseEffectNodeData>[] {
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

    // Score-based highlighting takes precedence when active
    if (scoreHighlight && node.data.scores) {
      const score = node.data.scores[scoreHighlight];
      highlightColor = SCORE_TO_COLOR[scoreHighlight];
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
      highlightColor = SCORE_TO_COLOR[scoreHighlight];
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
        scoreIntensity,
        highlightColor,
        activeScoreDimension: scoreHighlight,
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
}
