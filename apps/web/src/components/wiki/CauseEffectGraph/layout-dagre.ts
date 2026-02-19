/**
 * Dagre-based layout algorithm for hierarchical DAGs
 * Simpler and often cleaner than ELK for standard graphs
 */
import Dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';
import type { CauseEffectNodeData, CauseEffectEdgeData } from './types';
import { estimateNodeDimensions, getStyledEdges } from './layout-utils';

import type { GraphConfig } from './types';

export function getDagreLayout(
  nodes: Node<CauseEffectNodeData>[],
  edges: Edge<CauseEffectEdgeData>[],
  graphConfig?: GraphConfig
): { nodes: Node<CauseEffectNodeData>[]; edges: Edge<CauseEffectEdgeData>[] } {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));

  // Use config values if provided, otherwise fall back to defaults
  const configNodeSpacing = graphConfig?.layout?.causeSpacing;
  const configLayerGap = graphConfig?.layout?.layerGap;

  // Adjust spacing based on graph size and compact mode
  const isLargeGraph = nodes.length > 50;
  const isCompact = graphConfig?.compactMode !== false; // Default to compact

  // Calculate node spacing - use config if provided, else use compact/normal defaults
  let nodeSpacing: number;
  if (configNodeSpacing !== undefined) {
    nodeSpacing = configNodeSpacing;
  } else if (isCompact) {
    nodeSpacing = isLargeGraph ? 20 : 35;
  } else {
    nodeSpacing = isLargeGraph ? 30 : 50;
  }

  // Calculate rank spacing (layer gap) - use config if provided, else use compact/normal defaults
  let rankSpacing: number;
  if (configLayerGap !== undefined) {
    rankSpacing = configLayerGap;
  } else if (isCompact) {
    rankSpacing = isLargeGraph ? 80 : 60;
  } else {
    rankSpacing = isLargeGraph ? 120 : 80;
  }

  g.setGraph({
    rankdir: 'TB',
    nodesep: nodeSpacing,
    ranksep: rankSpacing,
    marginx: 10,
    marginy: 10,
    ranker: 'tight-tree',
    acyclicer: 'greedy',
    align: 'UL',
  });

  // Group nodes by type to assign ranks
  const causeNodes: string[] = [];
  const intermediateNodes: string[] = [];
  const effectNodes: string[] = [];

  nodes.forEach((node) => {
    const nodeType = node.data.type;
    if (nodeType === 'cause' || nodeType === 'leaf') {
      causeNodes.push(node.id);
    } else if (nodeType === 'intermediate') {
      intermediateNodes.push(node.id);
    } else if (nodeType === 'effect') {
      effectNodes.push(node.id);
    }
  });

  // Add nodes with dynamic dimensions based on type
  // Use configurable nodeWidth from graphConfig if provided
  const configuredWidth = graphConfig?.nodeWidth;
  nodes.forEach((node) => {
    const dims = estimateNodeDimensions(node);
    g.setNode(node.id, {
      width: configuredWidth ?? dims.width,
      height: dims.height,
    });
  });

  // Add edges
  edges.forEach((edge) => {
    g.setEdge(edge.source, edge.target);
  });

  // Add invisible edges to enforce layering: cause → intermediate → effect
  if (causeNodes.length > 0 && intermediateNodes.length > 0) {
    const firstCause = causeNodes[0];
    intermediateNodes.forEach(intNode => {
      if (!edges.some(e => e.source === firstCause && e.target === intNode)) {
        g.setEdge(firstCause, intNode, { weight: 0, minlen: 2 });
      }
    });
  }

  if (intermediateNodes.length > 0 && effectNodes.length > 0) {
    const firstIntermediate = intermediateNodes[0];
    effectNodes.forEach(effNode => {
      if (!edges.some(e => e.source === firstIntermediate && e.target === effNode)) {
        g.setEdge(firstIntermediate, effNode, { weight: 0, minlen: 2 });
      }
    });
  }

  // If no intermediates, connect causes directly to effects
  if (intermediateNodes.length === 0 && causeNodes.length > 0 && effectNodes.length > 0) {
    const firstCause = causeNodes[0];
    effectNodes.forEach(effNode => {
      if (!edges.some(e => e.source === firstCause && e.target === effNode)) {
        g.setEdge(firstCause, effNode, { weight: 0, minlen: 3 });
      }
    });
  }

  // Run the layout
  Dagre.layout(g);

  // Apply positions back to nodes, centering based on actual dimensions
  const layoutedNodes = nodes.map((node) => {
    const dagreNode = g.node(node.id);
    const dims = estimateNodeDimensions(node);
    return {
      ...node,
      position: {
        x: dagreNode.x - dims.width / 2,
        y: dagreNode.y - dims.height / 2,
      },
    };
  });

  // Dagre places nodes by center, so nodes with different heights end up at different Y positions
  // even when in the same rank. Fix by aligning nodes in the same rank by their top edge.
  // Group nodes by their approximate Y center (Dagre rank) - nodes within 5px are in the same rank
  const rankTolerance = 5;
  const ranks: Map<number, typeof layoutedNodes> = new Map();

  for (const node of layoutedNodes) {
    const dagreNode = g.node(node.id);
    const centerY = dagreNode.y;

    // Find existing rank within tolerance
    let foundRank: number | null = null;
    for (const [rankY] of ranks) {
      if (Math.abs(rankY - centerY) < rankTolerance) {
        foundRank = rankY;
        break;
      }
    }

    if (foundRank !== null) {
      ranks.get(foundRank)!.push(node);
    } else {
      ranks.set(centerY, [node]);
    }
  }

  // For each rank, align all nodes to the same top Y (use the maximum Y, i.e., lowest top edge)
  for (const nodesInRank of ranks.values()) {
    if (nodesInRank.length > 1) {
      const maxTopY = Math.max(...nodesInRank.map(n => n.position.y));
      for (const node of nodesInRank) {
        node.position.y = maxTopY;
      }
    }
  }

  return { nodes: layoutedNodes, edges: getStyledEdges(edges) };
}
