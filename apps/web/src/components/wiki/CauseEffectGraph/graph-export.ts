/**
 * Graph export utilities for CauseEffectGraph.
 *
 * Generates YAML and Mermaid representations of graph data.
 */

import type { Node, Edge } from '@xyflow/react';
import type { CauseEffectNodeData, CauseEffectEdgeData } from './types';

/** Generate YAML representation of graph data. */
export function toYaml(
  nodes: Node<CauseEffectNodeData>[],
  edges: Edge<CauseEffectEdgeData>[]
): string {
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

/** Generate Mermaid flowchart syntax from graph data. */
export function generateMermaidCode(
  nodes: Node<CauseEffectNodeData>[],
  edges: Edge<CauseEffectEdgeData>[],
  direction: 'TD' | 'LR' = 'TD'
): string {
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
