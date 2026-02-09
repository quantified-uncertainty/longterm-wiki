/**
 * Shared utilities for graph layout algorithms
 */
import { MarkerType, type Node, type Edge } from '@xyflow/react';
import type { CauseEffectNodeData, CauseEffectEdgeData, GraphConfig, TypeLabels } from './types';
import {
  NODE_WIDTH,
  NODE_HEIGHT_WITH_SUBITEMS,
  GROUP_PADDING,
  GROUP_HEADER_HEIGHT,
  groupConfig,
  DEFAULT_TYPE_LABELS,
} from './config';

// Use larger height for layout since most nodes have subItems
export const LAYOUT_NODE_HEIGHT = NODE_HEIGHT_WITH_SUBITEMS;

// Helper types
export type LayoutedNode = Node<CauseEffectNodeData>;
export type NodesByType = Record<string, LayoutedNode[]>;

// Estimate node width based on content (label and sub-items)
export function estimateNodeWidth(node: { data: CauseEffectNodeData }): number {
  const CHAR_WIDTH = 8; // Approximate pixels per character
  const MIN_WIDTH = NODE_WIDTH; // Must match actual rendered node width
  const PADDING = 40; // Internal padding

  // Get the longest text (label or any sub-item)
  let maxTextLength = node.data.label?.length || 0;

  if (node.data.subItems) {
    for (const item of node.data.subItems) {
      const itemLength = item.label?.length || 0;
      if (itemLength > maxTextLength) {
        maxTextLength = itemLength;
      }
    }
  }

  const estimatedWidth = maxTextLength * CHAR_WIDTH + PADDING;
  return Math.max(MIN_WIDTH, estimatedWidth);
}

// Estimate node dimensions based on type and content
export function estimateNodeDimensions(node: Node<CauseEffectNodeData>): { width: number; height: number } {
  const nodeType = node.type;
  const data = node.data;

  // ClusterContainer nodes - sized to contain expandable children
  if (nodeType === 'clusterContainer') {
    const childCount = (data as Record<string, unknown>).childCount as number || 3;
    const width = Math.min(800, 100 + childCount * 220);
    const height = 140;
    return { width, height };
  }

  // Cluster nodes are much larger (have header, description, preview items)
  if (nodeType === 'cluster') {
    const previewItems = (data as Record<string, unknown>).previewItems as string[] | undefined;
    const numPreviewItems = previewItems?.length || 0;
    const hasDescription = !!(data as Record<string, unknown>).description;

    const baseWidth = 280;
    const width = Math.min(400, baseWidth + numPreviewItems * 20);

    let height = 60;
    if (hasDescription) height += 30;
    if (numPreviewItems > 0) height += 50;

    return { width, height };
  }

  // Expandable nodes are medium-sized
  if (nodeType === 'expandable') {
    return { width: 200, height: 80 };
  }

  // CauseEffect nodes with subItems are taller
  if (data.subItems && data.subItems.length > 0) {
    const numSubItems = data.subItems.length;
    return {
      width: NODE_WIDTH + 40,
      height: 80 + numSubItems * 28,
    };
  }

  // Regular nodes
  return {
    width: NODE_WIDTH + 20,
    height: LAYOUT_NODE_HEIGHT * 0.7,
  };
}

// Style edges - variable weight based on strength
export function getStyledEdges(edges: Edge<CauseEffectEdgeData>[]): Edge<CauseEffectEdgeData>[] {
  const strengthMap = { strong: 2.5, medium: 1.5, weak: 1 };
  const edgeColor = '#d6d3d1';  // stone-300 for all edges

  return edges.map((edge) => {
    const data = edge.data;
    const strokeWidth = data?.strength ? strengthMap[data.strength] : 1.5;

    return {
      ...edge,
      label: data?.label,
      labelStyle: data?.label ? { fontSize: 11, fontWeight: 500, fill: '#64748b' } : undefined,
      labelBgStyle: data?.label ? { fill: '#f8fafc', fillOpacity: 0.9 } : undefined,
      labelBgPadding: data?.label ? [4, 6] as [number, number] : undefined,
      labelBgBorderRadius: data?.label ? 4 : undefined,
      style: { ...edge.style, stroke: edgeColor, strokeWidth },
      markerEnd: { type: MarkerType.Arrow, color: edgeColor, width: 15, height: 15, strokeWidth: 2 },
    };
  });
}

// Helper to position a row of nodes evenly around a center point
export function positionRow(nodes: LayoutedNode[], centerX: number, extraSpacing: number = 0) {
  if (nodes.length === 0) return;
  if (nodes.length === 1) {
    nodes[0].position.x = centerX - NODE_WIDTH / 2;
    return;
  }
  const spacing = NODE_WIDTH + 20 + extraSpacing;
  const totalWidth = (nodes.length - 1) * spacing;
  const startX = centerX - totalWidth / 2;
  nodes.forEach((node, i) => {
    node.position.x = startX + i * spacing;
  });
}

// Get barycenter (average X of connected nodes)
export function getBarycenter(nodeId: string, connectedNodes: LayoutedNode[], edges: Edge<CauseEffectEdgeData>[]) {
  const connected = connectedNodes.filter(n =>
    edges.some(e => (e.source === nodeId && e.target === n.id) || (e.target === nodeId && e.source === n.id))
  );
  if (connected.length === 0) return 0;
  return connected.reduce((sum, n) => sum + n.position.x, 0) / connected.length;
}

// Sort nodes by barycenter
export function sortByBarycenter(group: LayoutedNode[], neighbors: LayoutedNode[], edges: Edge<CauseEffectEdgeData>[]) {
  group.sort((a, b) => {
    const aBC = getBarycenter(a.id, neighbors, edges);
    const bBC = getBarycenter(b.id, neighbors, edges);
    if (aBC === bBC) return a.position.x - b.position.x;
    return aBC - bBC;
  });
}

// Group nodes by type
export function groupNodesByType(nodes: LayoutedNode[]): NodesByType {
  const result: NodesByType = {};
  for (const node of nodes) {
    const type = node.data.type || 'intermediate';
    if (!result[type]) result[type] = [];
    result[type].push(node);
  }
  return result;
}

// Group nodes by subgroup
export function groupNodesBySubgroup(nodes: LayoutedNode[] | undefined): Record<string, LayoutedNode[]> {
  const result: Record<string, LayoutedNode[]> = {};
  if (!nodes) return result;

  for (const node of nodes) {
    const subgroup = node.data.subgroup || 'default';
    if (!result[subgroup]) result[subgroup] = [];
    result[subgroup].push(node);
  }
  return result;
}

// Create a group container node with fixed width
export function createGroupContainer(
  type: string,
  nodesInGroup: LayoutedNode[],
  globalCenterX: number,
  containerWidth: number,
  typeLabels?: TypeLabels
): Node<CauseEffectNodeData> | null {
  if (nodesInGroup.length === 0) return null;

  const config = groupConfig[type];
  if (!config) return null;
  const minX = globalCenterX - containerWidth / 2;
  const minY = Math.min(...nodesInGroup.map(n => n.position.y)) - GROUP_PADDING - GROUP_HEADER_HEIGHT;
  let maxY = Math.max(...nodesInGroup.map(n => n.position.y + LAYOUT_NODE_HEIGHT)) + GROUP_PADDING;

  // Type-specific height adjustments
  if (type === 'intermediate') {
    maxY += 20;
  } else if (type === 'effect') {
    maxY -= 40;
  }

  const label = typeLabels?.[type as keyof TypeLabels] || config.label;

  return {
    id: `group-${type}`,
    type: 'group',
    position: { x: minX, y: minY },
    data: { label, type: type as CauseEffectNodeData['type'] },
    style: {
      width: containerWidth,
      height: maxY - minY,
      backgroundColor: config.bgColor,
      border: `2px dashed ${config.borderColor}`,
      borderRadius: '12px',
      zIndex: -1,
    },
    selectable: false,
    draggable: false,
  };
}

// Default configuration - compact layout for smaller graphs
export const DEFAULT_CONFIG: Required<GraphConfig> = {
  layout: {
    containerWidth: 900,
    centerX: 450,
    layerGap: 30,
    causeSpacing: 40,
    intermediateSpacing: 60,
    effectSpacing: 80,
  },
  typeLabels: DEFAULT_TYPE_LABELS as TypeLabels,
  subgroups: {},
  legendItems: [],
  elkOptions: {},
  hideGroupBackgrounds: false,
  hideGroupLabels: false,
  compactMode: true,
  straightEdges: false,
  nodeWidth: 180,
  useDagre: false,
  layoutAlgorithm: 'dagre' as const,
};
