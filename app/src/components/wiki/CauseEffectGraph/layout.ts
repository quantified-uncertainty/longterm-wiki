/**
 * Main layout module - Dagre-only layout for the Next.js site
 *
 * Simplified from the Astro version: only supports Dagre layout algorithm.
 */
import type { Node, Edge } from '@xyflow/react';
import type { CauseEffectNodeData, CauseEffectEdgeData, GraphConfig } from './types';
import { getDagreLayout } from './layout-dagre';

// Re-export shared utilities
export {
  getStyledEdges,
  estimateNodeWidth,
  estimateNodeDimensions,
  positionRow,
  getBarycenter,
  sortByBarycenter,
  groupNodesByType,
  groupNodesBySubgroup,
  createGroupContainer,
  LAYOUT_NODE_HEIGHT,
  DEFAULT_CONFIG,
  type LayoutedNode,
  type NodesByType,
} from './layout-utils';

// Main layout function - uses Dagre
export async function getLayoutedElements(
  nodes: Node<CauseEffectNodeData>[],
  edges: Edge<CauseEffectEdgeData>[],
  graphConfig?: GraphConfig
): Promise<{ nodes: Node<CauseEffectNodeData>[]; edges: Edge<CauseEffectEdgeData>[] }> {
  return getDagreLayout(nodes, edges, graphConfig);
}
