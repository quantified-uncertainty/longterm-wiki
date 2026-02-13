// Safety Research Generalizability graph data loader
// Loads and transforms the YAML data for visualization

import fs from 'fs';
import path from 'path';
import type { Node, Edge } from '@xyflow/react';
import type { CauseEffectNodeData, CauseEffectEdgeData } from '@/components/wiki/CauseEffectGraph/types';
import yaml from 'js-yaml';

// Lazy-loaded YAML content from repo-root data directory
let _rawYaml: string | null = null;
function getGraphYaml(): string {
  if (!_rawYaml) {
    const yamlPath = path.join(process.cwd(), '../data/graphs/safety-research-generalizability.yaml');
    _rawYaml = fs.readFileSync(yamlPath, 'utf-8');
  }
  return _rawYaml;
}

// Types for the raw YAML structure
interface RawSubItem {
  id?: string;
  label?: string;
  description?: string;
}

interface RawNode {
  id: string;
  label: string;
  description?: string;
  type: 'cause' | 'intermediate' | 'effect';
  order?: number;
  subgroup?: string;
  subItems?: RawSubItem[];
}

interface RawEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  strength?: 'strong' | 'medium' | 'weak';
  effect?: 'increases' | 'decreases';
}

interface RawGraphData {
  nodes: RawNode[];
  edges: RawEdge[];
}

// Parse YAML (lazy-loaded)
let _rawData: RawGraphData | null = null;
function getRawData(): RawGraphData {
  if (!_rawData) {
    _rawData = yaml.load(getGraphYaml()) as RawGraphData;
  }
  return _rawData;
}

// Color schemes for subgroups (approach-specific)
const SUBGROUP_COLORS: Record<string, { bg: string; border: string; text: string; accent: string }> = {
  // Mech Interp dependencies (red/rose theme - high risk of not generalizing)
  'mi-deps': {
    bg: '#fef2f2',
    border: 'rgba(239, 68, 68, 0.35)',
    text: '#991b1b',
    accent: '#ef4444',
  },
  'mi-threats': {
    bg: '#fef2f2',
    border: 'rgba(239, 68, 68, 0.5)',
    text: '#991b1b',
    accent: '#dc2626',
  },
  // Training-based dependencies (amber theme)
  'tb-deps': {
    bg: '#fffbeb',
    border: 'rgba(245, 158, 11, 0.35)',
    text: '#92400e',
    accent: '#f59e0b',
  },
  'tb-threats': {
    bg: '#fffbeb',
    border: 'rgba(245, 158, 11, 0.5)',
    text: '#92400e',
    accent: '#d97706',
  },
  // Black-box evals dependencies (blue theme)
  'be-deps': {
    bg: '#eff6ff',
    border: 'rgba(59, 130, 246, 0.35)',
    text: '#1e40af',
    accent: '#3b82f6',
  },
  'be-threats': {
    bg: '#eff6ff',
    border: 'rgba(59, 130, 246, 0.5)',
    text: '#1e40af',
    accent: '#2563eb',
  },
  // Control dependencies (teal theme)
  'cc-deps': {
    bg: '#f0fdfa',
    border: 'rgba(20, 184, 166, 0.35)',
    text: '#115e59',
    accent: '#14b8a6',
  },
  // Theoretical dependencies (violet theme)
  'ta-deps': {
    bg: '#f5f3ff',
    border: 'rgba(139, 92, 246, 0.35)',
    text: '#5b21b6',
    accent: '#8b5cf6',
  },
};

// Colors for effect nodes (safety approaches) - based on generalization level
const EFFECT_COLORS: Record<string, { bg: string; border: string; text: string; accent: string }> = {
  'mechanistic-interp': {
    bg: '#fee2e2',
    border: 'rgba(239, 68, 68, 0.5)',
    text: '#991b1b',
    accent: '#ef4444',
  },
  'training-based': {
    bg: '#fef3c7',
    border: 'rgba(245, 158, 11, 0.5)',
    text: '#92400e',
    accent: '#f59e0b',
  },
  'blackbox-evals': {
    bg: '#dbeafe',
    border: 'rgba(59, 130, 246, 0.5)',
    text: '#1e40af',
    accent: '#3b82f6',
  },
  'control-containment': {
    bg: '#ccfbf1',
    border: 'rgba(20, 184, 166, 0.5)',
    text: '#115e59',
    accent: '#14b8a6',
  },
  'theoretical-alignment': {
    bg: '#dcfce7',
    border: 'rgba(34, 197, 94, 0.5)',
    text: '#166534',
    accent: '#22c55e',
  },
};

// Helper to get node colors
function getNodeColors(type: string, subgroup?: string, nodeId?: string): { bg: string; border: string; text: string; accent: string } | undefined {
  if (type === 'cause' && subgroup && SUBGROUP_COLORS[subgroup]) {
    return SUBGROUP_COLORS[subgroup];
  }
  if (type === 'effect' && nodeId && EFFECT_COLORS[nodeId]) {
    return EFFECT_COLORS[nodeId];
  }
  return undefined;
}

// Validate edges reference valid node IDs
function validateGraph(data: RawGraphData): string[] {
  const errors: string[] = [];
  const nodeIds = new Set(data.nodes.map(n => n.id));

  for (const edge of data.edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push(`Edge "${edge.id}": source "${edge.source}" not found in nodes`);
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(`Edge "${edge.id}": target "${edge.target}" not found in nodes`);
    }
  }

  return errors;
}

// Transform sub-items
function transformSubItems(items?: RawSubItem[]): { label: string; description?: string }[] | undefined {
  if (!items) return undefined;
  return items.map(item => ({
    label: item.label || item.id || '',
    description: item.description,
  }));
}

// Lazy-computed exports (server-only, uses fs)
let _nodes: Node<CauseEffectNodeData>[] | null = null;
let _edges: Edge<CauseEffectEdgeData>[] | null = null;

function getSafetyGeneralizabilityNodes(): Node<CauseEffectNodeData>[] {
  if (!_nodes) {
    const rawData = getRawData();
    _nodes = rawData.nodes.map(node => ({
      id: node.id,
      type: 'causeEffect',
      position: { x: 0, y: 0 },
      data: {
        label: node.label,
        description: node.description,
        type: node.type,
        order: node.order,
        subgroup: node.subgroup,
        subItems: transformSubItems(node.subItems),
        nodeColors: getNodeColors(node.type, node.subgroup, node.id),
      },
    }));
  }
  return _nodes;
}

function getSafetyGeneralizabilityEdges(): Edge<CauseEffectEdgeData>[] {
  if (!_edges) {
    const rawData = getRawData();
    _edges = rawData.edges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      data: {
        label: edge.label,
        strength: edge.strength,
        effect: edge.effect,
      },
    }));
  }
  return _edges;
}

export function getRawGraphData(): RawGraphData {
  return getRawData();
}

// Helper to get approaches with their dependencies
export interface ApproachDependency {
  id: string;
  label: string;
  description?: string;
  isRequirement: boolean; // true = enables, false = threatens
}

export interface SafetyApproach {
  id: string;
  label: string;
  description?: string;
  generalizationLevel: 'LOW' | 'MEDIUM' | 'MEDIUM-HIGH' | 'HIGH' | 'HIGHEST';
  examples: string;
  dependencies: ApproachDependency[];
  threats: ApproachDependency[];
}

export function getSafetyApproaches(): SafetyApproach[] {
  const rawData = getRawData();
  const approaches: SafetyApproach[] = [];

  const effectNodes = rawData.nodes.filter(n => n.type === 'effect');

  for (const effect of effectNodes) {
    // Find all edges pointing to this effect
    const incomingEdges = rawData.edges.filter(e => e.target === effect.id);

    const dependencies: ApproachDependency[] = [];
    const threats: ApproachDependency[] = [];

    for (const edge of incomingEdges) {
      const sourceNode = rawData.nodes.find(n => n.id === edge.source);
      if (!sourceNode) continue;

      const dep: ApproachDependency = {
        id: sourceNode.id,
        label: sourceNode.label,
        description: sourceNode.description,
        isRequirement: edge.effect === 'increases',
      };

      if (edge.effect === 'increases') {
        dependencies.push(dep);
      } else {
        threats.push(dep);
      }
    }

    // Extract generalization level and examples from subItems
    let generalizationLevel: SafetyApproach['generalizationLevel'] = 'MEDIUM';
    let examples = '';

    if (effect.subItems) {
      for (const item of effect.subItems) {
        if (item.label?.includes('Generalization:')) {
          const match = item.label.match(/Generalization: (\S+)/);
          if (match) {
            generalizationLevel = match[1] as SafetyApproach['generalizationLevel'];
          }
        }
        if (item.label?.includes('Examples:')) {
          examples = item.label.replace('Examples: ', '');
        }
      }
    }

    approaches.push({
      id: effect.id,
      label: effect.label,
      description: effect.description,
      generalizationLevel,
      examples,
      dependencies,
      threats,
    });
  }

  return approaches;
}
