/**
 * Graph traversal algorithms for CauseEffectGraph.
 *
 * Pure functions for computing node/edge neighborhoods and causal paths.
 */

import type { Edge } from '@xyflow/react';
import type { CauseEffectEdgeData } from './types';

/**
 * Unified graph traversal function for computing node/edge neighborhoods.
 * - 'directed': Traverses upstream and downstream separately (for causal paths)
 * - 'undirected': Treats edges as bidirectional (for local neighborhood)
 */
export function traverseGraph(
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

/** Convenience wrapper for causal path computation (directed traversal). */
export const computeCausalPath = (
  startNodeId: string,
  edges: Edge<CauseEffectEdgeData>[],
  maxDepth = 10
) => traverseGraph(startNodeId, edges, maxDepth, 'directed');
