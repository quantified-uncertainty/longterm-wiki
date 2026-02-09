/**
 * Master Graph Data Loader
 *
 * Loads the unified AI Transition Model graph and provides
 * both overview (category-level) and detailed views.
 *
 * Ported from apps/longterm/src/data/master-graph-data.ts
 * Uses fs.readFileSync instead of Vite ?raw imports, with lazy loading pattern
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { Node, Edge } from '@xyflow/react';
import type { CauseEffectNodeData, CauseEffectEdgeData } from '@/components/wiki/CauseEffectGraph/types';

// Lazy-loaded raw YAML content (check local dir first, fall back to longterm)
let _rawYaml: string | null = null;
function getRawYaml(): string {
  if (!_rawYaml) {
    const localPath = path.join(process.cwd(), 'src/data/graphs/ai-transition-model-master.yaml');
    const longtermPath = path.join(process.cwd(), '../data/graphs/ai-transition-model-master.yaml');
    _rawYaml = fs.readFileSync(
      fs.existsSync(localPath) ? localPath : longtermPath,
      'utf-8'
    );
  }
  return _rawYaml;
}

// Types for the YAML structure
interface SubItem {
  id: string;
  label: string;
}

interface Category {
  id: string;
  label: string;
  type: 'cause' | 'intermediate' | 'effect';
  subgroup?: string;
  order?: number;
  description?: string;
  entityRef?: string;
  subItems?: SubItem[];
}

interface CategoryEdge {
  source: string;
  target: string;
  strength?: 'weak' | 'medium' | 'strong';
  effect?: 'increases' | 'decreases' | 'mixed';
  label?: string;
}

interface DetailedNode {
  id: string;
  label: string;
  category: string;
  subcategory?: string;
  type: 'leaf' | 'intermediate' | 'effect';
  description?: string;
  entityRef?: string;
}

interface DetailedEdge {
  source: string;
  target: string;
  strength?: 'weak' | 'medium' | 'strong';
  effect?: 'increases' | 'decreases' | 'mixed';
  label?: string;
}

interface SubgraphSpec {
  entityId: string;
  centerNode: string;
  depth?: number;
  title?: string;
  level?: 'overview' | 'detailed';
  includeNodes?: string[];
  excludeNodes?: string[];
}

interface MasterGraphYaml {
  id: string;
  title: string;
  description?: string;
  version?: string;
  categories: Category[];
  categoryEdges: CategoryEdge[];
  detailedNodes: DetailedNode[];
  detailedEdges: DetailedEdge[];
  subgraphs?: SubgraphSpec[];
}

// Parse and cache
let cachedData: MasterGraphYaml | null = null;

function getData(): MasterGraphYaml {
  if (!cachedData) {
    cachedData = yaml.load(getRawYaml()) as MasterGraphYaml;
  }
  return cachedData;
}

/**
 * Get overview-level nodes (categories with sub-items)
 */
export function getOverviewNodes(): Node<CauseEffectNodeData>[] {
  const data = getData();

  return data.categories.map((cat) => {
    // Determine base path based on category type
    const getSubItemPath = (itemId: string) => {
      if (cat.type === 'intermediate') {
        // Scenarios
        return `/ai-transition-model/scenarios/${cat.id}/${itemId}/`;
      } else if (cat.type === 'effect') {
        // Outcomes (typically don't have sub-items with pages)
        return `/ai-transition-model/outcomes/${itemId}/`;
      }
      // Root factors
      return `/ai-transition-model/factors/${cat.id}/${itemId}/`;
    };

    // Determine category page href
    const getCategoryHref = () => {
      if (cat.type === 'intermediate') {
        return `/ai-transition-model/scenarios/${cat.id}/`;
      } else if (cat.type === 'effect') {
        return `/ai-transition-model/outcomes/${cat.id}/`;
      }
      return `/ai-transition-model/factors/${cat.id}/`;
    };

    return {
      id: cat.id,
      type: 'causeEffect' as const,
      position: { x: 0, y: 0 },
      data: {
        label: cat.label,
        description: cat.description || '',
        type: cat.type,
        order: cat.order,
        subgroup: cat.subgroup,
        href: getCategoryHref(),
        subItems: cat.subItems?.map((item) => ({
          label: item.label,
          href: getSubItemPath(item.id),
        })),
      },
    };
  });
}

/**
 * Get overview-level edges (between categories)
 */
export function getOverviewEdges(): Edge<CauseEffectEdgeData>[] {
  const data = getData();

  return data.categoryEdges.map((edge, i) => ({
    id: `cat-${i}-${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    data: {
      strength: edge.strength || 'medium',
      effect: edge.effect || 'increases',
    },
    label: edge.label,
  }));
}

/**
 * Get detailed nodes (all granular factors)
 */
// Generate href based on node ID, category, and type
// Maps nodes to their corresponding ATM pages if they exist
function getNodeHref(
  nodeId: string,
  category?: string,
  subcategory?: string,
  nodeType?: 'leaf' | 'intermediate' | 'effect'
): string | undefined {
  // Detailed leaf nodes typically don't have dedicated pages
  // Only link to pages that exist for categories, sub-items, scenarios, and outcomes

  // Check if this node is a category or subcategory (not a granular leaf node)
  const data = getData();

  // Check if it's a category with a page
  const categoryObj = data.categories.find(c => c.id === nodeId);
  if (categoryObj) {
    if (categoryObj.type === 'intermediate') {
      // Scenarios: /ai-transition-model/scenarios/{id}/
      return `/ai-transition-model/scenarios/${nodeId}/`;
    } else if (categoryObj.type === 'effect') {
      // Outcomes: /ai-transition-model/outcomes/{id}/
      return `/ai-transition-model/outcomes/${nodeId}/`;
    } else {
      // Root factors: /ai-transition-model/factors/{id}/
      return `/ai-transition-model/factors/${nodeId}/`;
    }
  }

  // Check if it's a subcategory (sub-item) of a category
  for (const cat of data.categories) {
    const subItem = cat.subItems?.find(s => s.id === nodeId);
    if (subItem) {
      if (cat.type === 'intermediate') {
        // Scenario sub-items: /ai-transition-model/scenarios/{category}/{id}/
        return `/ai-transition-model/scenarios/${cat.id}/${nodeId}/`;
      } else if (cat.type === 'cause') {
        // Factor sub-items: /ai-transition-model/factors/{category}/{id}/
        return `/ai-transition-model/factors/${cat.id}/${nodeId}/`;
      }
    }
  }

  // For detailed nodes, only link if they match a subcategory name
  // (i.e., granular nodes like 'taiwan-stability' don't have pages)
  if (category && subcategory) {
    const parentCat = data.categories.find(c => c.id === category);
    if (parentCat?.subItems?.some(s => s.id === subcategory)) {
      // The subcategory has a page, but individual detailed nodes within it don't
      return undefined;
    }
  }

  return undefined;
}

/**
 * Exported function to get href for a node ID based on master graph structure.
 * Used by DiagramViewer to add link icons to nodes that correspond to pages.
 */
export function getNodeHrefFromMaster(nodeId: string): string | undefined {
  return getNodeHref(nodeId);
}

export function getDetailedNodes(): Node<CauseEffectNodeData>[] {
  const data = getData();

  return data.detailedNodes.map((node) => ({
      id: node.id,
      type: 'causeEffect' as const,
      position: { x: 0, y: 0 },
      data: {
        label: node.label,
        description: node.description || '',
        type: node.type === 'leaf' ? 'cause' : node.type,
        // Use category as subgroup for visual clustering
        subgroup: node.category,
        // Add href if this node corresponds to a page
        href: getNodeHref(node.id, node.category, node.subcategory, node.type),
      },
    }));
}

/**
 * Get detailed edges
 */
export function getDetailedEdges(): Edge<CauseEffectEdgeData>[] {
  const data = getData();

  return data.detailedEdges.map((edge, i) => ({
    id: `det-${i}-${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    data: {
      strength: edge.strength || 'medium',
      effect: edge.effect || 'increases',
    },
    label: edge.label,
  }));
}

/**
 * Get expanded-level nodes (subcategories as separate nodes)
 * This is an intermediate level between overview and detailed
 */
export function getExpandedNodes(): Node<CauseEffectNodeData>[] {
  const data = getData();
  const nodes: Node<CauseEffectNodeData>[] = [];

  // Helper to get correct sub-item path based on category type
  const getSubItemPath = (cat: Category, itemId: string) => {
    if (cat.type === 'intermediate') {
      return `/ai-transition-model/scenarios/${cat.id}/${itemId}/`;
    } else if (cat.type === 'effect') {
      return `/ai-transition-model/outcomes/${itemId}/`;
    }
    return `/ai-transition-model/factors/${cat.id}/${itemId}/`;
  };

  // Helper to get category page path
  const getCategoryHref = (cat: Category) => {
    if (cat.type === 'intermediate') {
      return `/ai-transition-model/scenarios/${cat.id}/`;
    } else if (cat.type === 'effect') {
      return `/ai-transition-model/outcomes/${cat.id}/`;
    }
    return `/ai-transition-model/factors/${cat.id}/`;
  };

  // Add scenarios and outcomes as regular nodes (no sub-items)
  for (const cat of data.categories) {
    if (cat.type === 'intermediate' || cat.type === 'effect') {
      nodes.push({
        id: cat.id,
        type: 'causeEffect' as const,
        position: { x: 0, y: 0 },
        data: {
          label: cat.label,
          description: cat.description || '',
          type: cat.type,
          order: cat.order,
          subgroup: cat.subgroup,
          href: getCategoryHref(cat),
          subItems: cat.subItems?.map((item) => ({
            label: item.label,
            href: getSubItemPath(cat, item.id),
          })),
        },
      });
    } else if (cat.subItems && cat.subItems.length > 0) {
      // For root factors with sub-items, create nodes for each sub-item
      for (const subItem of cat.subItems) {
        nodes.push({
          id: `${cat.id}--${subItem.id}`,
          type: 'causeEffect' as const,
          position: { x: 0, y: 0 },
          data: {
            label: subItem.label,
            description: '',
            type: cat.type,
            order: cat.order,
            subgroup: cat.subgroup || cat.id,
            href: getSubItemPath(cat, subItem.id),
          },
        });
      }
    } else {
      // Categories without sub-items stay as-is
      nodes.push({
        id: cat.id,
        type: 'causeEffect' as const,
        position: { x: 0, y: 0 },
        data: {
          label: cat.label,
          description: cat.description || '',
          type: cat.type,
          order: cat.order,
          subgroup: cat.subgroup,
          href: getCategoryHref(cat),
        },
      });
    }
  }

  return nodes;
}

/**
 * Get expanded-level edges (between subcategories and scenarios/outcomes)
 */
export function getExpandedEdges(): Edge<CauseEffectEdgeData>[] {
  const data = getData();
  const edges: Edge<CauseEffectEdgeData>[] = [];
  const nodeIds = new Set(getExpandedNodes().map((n) => n.id));

  // Create edges from subcategories to scenarios
  // We need to map category edges to subcategory edges
  for (const catEdge of data.categoryEdges) {
    const sourceCategory = data.categories.find((c) => c.id === catEdge.source);
    const targetCategory = data.categories.find((c) => c.id === catEdge.target);

    if (!sourceCategory || !targetCategory) continue;

    // If source has sub-items and is a root factor, connect each sub-item
    if (sourceCategory.subItems && sourceCategory.type === 'cause') {
      for (const subItem of sourceCategory.subItems) {
        const sourceId = `${sourceCategory.id}--${subItem.id}`;
        const targetId = targetCategory.id;

        if (nodeIds.has(sourceId) && nodeIds.has(targetId)) {
          edges.push({
            id: `exp-${sourceId}-${targetId}`,
            source: sourceId,
            target: targetId,
            data: {
              strength: catEdge.strength || 'medium',
              effect: catEdge.effect || 'increases',
            },
          });
        }
      }
    } else {
      // Keep the edge as-is for non-expandable categories
      if (nodeIds.has(catEdge.source) && nodeIds.has(catEdge.target)) {
        edges.push({
          id: `exp-cat-${catEdge.source}-${catEdge.target}`,
          source: catEdge.source,
          target: catEdge.target,
          data: {
            strength: catEdge.strength || 'medium',
            effect: catEdge.effect || 'increases',
          },
        });
      }
    }
  }

  // Add some cross-subcategory edges based on detailed edges
  // Group detailed edges by subcategory pairs
  const subcategoryEdges = new Map<string, { count: number; effects: string[] }>();

  for (const detEdge of data.detailedEdges) {
    const sourceNode = data.detailedNodes.find((n) => n.id === detEdge.source);
    const targetNode = data.detailedNodes.find((n) => n.id === detEdge.target);

    if (!sourceNode || !targetNode) continue;

    const sourceSubcat = `${sourceNode.category}--${sourceNode.subcategory}`;
    const targetSubcat = `${targetNode.category}--${targetNode.subcategory}`;

    // Skip same-subcategory edges
    if (sourceSubcat === targetSubcat) continue;

    // Only add if both subcategories exist as nodes
    if (!nodeIds.has(sourceSubcat) && !nodeIds.has(sourceNode.category)) continue;
    if (!nodeIds.has(targetSubcat) && !nodeIds.has(targetNode.category)) continue;

    const key = `${sourceSubcat}|${targetSubcat}`;
    if (!subcategoryEdges.has(key)) {
      subcategoryEdges.set(key, { count: 0, effects: [] });
    }
    const entry = subcategoryEdges.get(key)!;
    entry.count++;
    entry.effects.push(detEdge.effect || 'increases');
  }

  // Add edges between subcategories that have multiple detailed connections
  for (const [key, value] of subcategoryEdges) {
    if (value.count < 2) continue; // Only add if there are at least 2 underlying connections

    const [sourceSubcat, targetSubcat] = key.split('|');

    // Determine dominant effect
    const increaseCount = value.effects.filter((e) => e === 'increases').length;
    const decreaseCount = value.effects.filter((e) => e === 'decreases').length;
    const effect =
      increaseCount > decreaseCount
        ? 'increases'
        : decreaseCount > increaseCount
        ? 'decreases'
        : 'mixed';

    // Determine strength based on count
    const strength = value.count >= 5 ? 'strong' : value.count >= 3 ? 'medium' : 'weak';

    if (nodeIds.has(sourceSubcat) && nodeIds.has(targetSubcat)) {
      edges.push({
        id: `exp-sub-${sourceSubcat}-${targetSubcat}`,
        source: sourceSubcat,
        target: targetSubcat,
        data: {
          strength,
          effect: effect as 'increases' | 'decreases' | 'mixed',
        },
      });
    }
  }

  return edges;
}

/**
 * Get nodes and edges for a specific view level
 */
export function getGraphData(level: 'overview' | 'expanded' | 'detailed'): {
  nodes: Node<CauseEffectNodeData>[];
  edges: Edge<CauseEffectEdgeData>[];
} {
  if (level === 'overview') {
    return {
      nodes: getOverviewNodes(),
      edges: getOverviewEdges(),
    };
  }
  if (level === 'expanded') {
    return {
      nodes: getExpandedNodes(),
      edges: getExpandedEdges(),
    };
  }
  return {
    nodes: getDetailedNodes(),
    edges: getDetailedEdges(),
  };
}

/**
 * Get categories (for grouping in detailed view)
 */
export function getCategories(): Category[] {
  return getData().categories;
}

/**
 * Get detailed nodes for a specific category
 */
export function getNodesForCategory(categoryId: string): DetailedNode[] {
  const data = getData();
  return data.detailedNodes.filter((n) => n.category === categoryId);
}

/**
 * Extract a subgraph centered on a node
 */
export function extractSubgraph(
  centerNodeId: string,
  depth: number = 2,
  level: 'overview' | 'expanded' | 'detailed' = 'detailed'
): { nodes: Node<CauseEffectNodeData>[]; edges: Edge<CauseEffectEdgeData>[] } {
  const { nodes, edges } = getGraphData(level);

  // Build adjacency
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }

  // BFS to find nodes within depth
  const visited = new Set<string>([centerNodeId]);
  let frontier = new Set<string>([centerNodeId]);

  for (let d = 0; d < depth; d++) {
    const nextFrontier = new Set<string>();
    for (const nodeId of frontier) {
      const neighbors = adjacency.get(nodeId) || new Set();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          nextFrontier.add(neighbor);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  const filteredNodes = nodes.filter((n) => visited.has(n.id));
  const filteredEdges = edges.filter(
    (e) => visited.has(e.source) && visited.has(e.target)
  );

  return { nodes: filteredNodes, edges: filteredEdges };
}

/**
 * Get subgraph spec for an entity
 */
export function getSubgraphSpec(entityId: string): SubgraphSpec | undefined {
  const data = getData();
  return data.subgraphs?.find((s) => s.entityId === entityId);
}

/**
 * Get all available subgraph specs
 */
export function getAvailableSubgraphs(): SubgraphSpec[] {
  return getData().subgraphs || [];
}

/**
 * Get statistics about the master graph
 */
export function getMasterGraphStats(): {
  categoryCount: number;
  detailedNodeCount: number;
  categoryEdgeCount: number;
  detailedEdgeCount: number;
  subgraphCount: number;
} {
  const data = getData();
  return {
    categoryCount: data.categories.length,
    detailedNodeCount: data.detailedNodes.length,
    categoryEdgeCount: data.categoryEdges.length,
    detailedEdgeCount: data.detailedEdges.length,
    subgraphCount: data.subgraphs?.length || 0,
  };
}

/**
 * Category info for filter controls
 */
export interface FilterCategoryInfo {
  id: string;
  label: string;
  type: 'cause' | 'intermediate' | 'effect';
  subgroup?: string;
  nodeCount: number;
  subcategories: Array<{
    id: string;
    label: string;
    nodeCount: number;
  }>;
}

/**
 * Get category info for filter controls
 * Returns categories with node counts for detailed view filtering
 */
export function getFilterCategories(): FilterCategoryInfo[] {
  const data = getData();

  // Count nodes per category and subcategory
  const categoryNodeCounts = new Map<string, number>();
  const subcategoryNodeCounts = new Map<string, number>();

  for (const node of data.detailedNodes) {
    categoryNodeCounts.set(node.category, (categoryNodeCounts.get(node.category) || 0) + 1);
    if (node.subcategory) {
      const subKey = `${node.category}/${node.subcategory}`;
      subcategoryNodeCounts.set(subKey, (subcategoryNodeCounts.get(subKey) || 0) + 1);
    }
  }

  return data.categories.map((cat) => {
    // Get unique subcategories for this category
    const subcategories: Array<{ id: string; label: string; nodeCount: number }> = [];
    const seenSubcats = new Set<string>();

    for (const node of data.detailedNodes) {
      if (node.category === cat.id && node.subcategory && !seenSubcats.has(node.subcategory)) {
        seenSubcats.add(node.subcategory);
        const subKey = `${cat.id}/${node.subcategory}`;
        subcategories.push({
          id: node.subcategory,
          label: node.subcategory
            .split('-')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' '),
          nodeCount: subcategoryNodeCounts.get(subKey) || 0,
        });
      }
    }

    // For categories without detailed nodes (scenarios, outcomes), count as 1 (the category node itself)
    let nodeCount = categoryNodeCounts.get(cat.id) || 0;
    if (nodeCount === 0 && (cat.type === 'intermediate' || cat.type === 'effect')) {
      nodeCount = 1;  // The category node itself
    }

    return {
      id: cat.id,
      label: cat.label,
      type: cat.type,
      subgroup: cat.subgroup,
      nodeCount,
      subcategories,
    };
  });
}

// Category-specific colors for detailed view nodes
const CATEGORY_COLORS: Record<string, { bg: string; border: string; text: string; accent: string }> = {
  // AI System Factors (blue-ish tones)
  'misalignment-potential': {
    bg: '#fce7f3',           // pink-100
    border: 'rgba(236, 72, 153, 0.35)',
    text: '#9d174d',         // pink-800
    accent: '#ec4899',
  },
  'ai-capabilities': {
    bg: '#dbeafe',           // blue-100
    border: 'rgba(59, 130, 246, 0.35)',
    text: '#1e40af',         // blue-800
    accent: '#3b82f6',
  },
  'ai-uses': {
    bg: '#d1fae5',           // emerald-100
    border: 'rgba(16, 185, 129, 0.35)',
    text: '#065f46',         // emerald-800
    accent: '#10b981',
  },
  'ai-ownership': {
    bg: '#fef3c7',           // amber-100
    border: 'rgba(245, 158, 11, 0.35)',
    text: '#92400e',         // amber-800
    accent: '#f59e0b',
  },
  // Societal Factors (green-ish tones)
  'civilizational-competence': {
    bg: '#e0e7ff',           // indigo-100
    border: 'rgba(99, 102, 241, 0.35)',
    text: '#3730a3',         // indigo-800
    accent: '#6366f1',
  },
  'transition-turbulence': {
    bg: '#ffedd5',           // orange-100
    border: 'rgba(249, 115, 22, 0.35)',
    text: '#9a3412',         // orange-800
    accent: '#f97316',
  },
  // Scenarios (purple tones)
  'ai-takeover': {
    bg: '#ede9fe',           // violet-100
    border: 'rgba(139, 92, 246, 0.35)',
    text: '#5b21b6',         // violet-800
    accent: '#8b5cf6',
  },
  'human-caused-catastrophe': {
    bg: '#fae8ff',           // fuchsia-100
    border: 'rgba(217, 70, 239, 0.35)',
    text: '#86198f',         // fuchsia-800
    accent: '#d946ef',
  },
  'long-term-lockin': {
    bg: '#f3e8ff',           // purple-100
    border: 'rgba(168, 85, 247, 0.35)',
    text: '#6b21a8',         // purple-800
    accent: '#a855f7',
  },
  // Misuse potential (for societal factors without a subgroup)
  'misuse-potential': {
    bg: '#fee2e2',           // red-100
    border: 'rgba(239, 68, 68, 0.35)',
    text: '#991b1b',         // red-800
    accent: '#ef4444',
  },
  // Outcomes
  'existential-catastrophe': {
    bg: '#fee2e2',           // red-100
    border: 'rgba(239, 68, 68, 0.35)',
    text: '#991b1b',         // red-800
    accent: '#ef4444',
  },
  'lock-in': {
    bg: '#fef9c3',           // yellow-100
    border: 'rgba(234, 179, 8, 0.35)',
    text: '#854d0e',         // yellow-800
    accent: '#eab308',
  },
  'positive-transition': {
    bg: '#dcfce7',           // green-100
    border: 'rgba(34, 197, 94, 0.35)',
    text: '#166534',         // green-800
    accent: '#22c55e',
  },
};

// Export for use in FilterControls
export function getCategoryColor(categoryId: string): { bg: string; border: string; text: string; accent: string } | undefined {
  return CATEGORY_COLORS[categoryId];
}

// Edge density type
export type EdgeDensity = 'minimal' | 'low' | 'medium' | 'high' | 'all';

/**
 * Filter detailed nodes based on filter settings
 */
export function getFilteredDetailedData(filters: {
  categories: Record<string, boolean>;
  subgroups: Record<string, boolean>;
  types: Record<string, boolean>;
  subcategories: Record<string, boolean>;
  edgeDensity?: EdgeDensity;
}): { nodes: Node<CauseEffectNodeData>[]; edges: Edge<CauseEffectEdgeData>[] } {
  const data = getData();
  const categories = getFilterCategories();

  // Build a map of category -> subgroup for filtering
  const categorySubgroups = new Map<string, string>();
  for (const cat of categories) {
    if (cat.subgroup) {
      categorySubgroups.set(cat.id, cat.subgroup);
    }
  }

  // Filter nodes
  const filteredNodeIds = new Set<string>();
  const filteredNodes: Node<CauseEffectNodeData>[] = [];

  // First, add detailed nodes (granular factors)
  for (const node of data.detailedNodes) {
    // Check category filter
    if (filters.categories[node.category] === false) continue;

    // Check subgroup filter
    const subgroup = categorySubgroups.get(node.category);
    if (subgroup && filters.subgroups[subgroup] === false) continue;

    // Check type filter (detailed nodes use 'leaf' or 'intermediate', map to cause/intermediate)
    const nodeType = node.type === 'leaf' ? 'cause' : node.type;
    if (filters.types[nodeType] === false) continue;

    // Check subcategory filter
    if (node.subcategory && filters.subcategories[node.subcategory] === false) continue;

    // Get category color
    const categoryColor = CATEGORY_COLORS[node.category];

    filteredNodeIds.add(node.id);
    filteredNodes.push({
      id: node.id,
      type: 'causeEffect' as const,
      position: { x: 0, y: 0 },
      data: {
        label: node.label,
        description: node.description || '',
        type: node.type === 'leaf' ? 'cause' : node.type,
        subgroup: node.category,
        nodeColors: categoryColor,  // Apply category-specific color
        href: getNodeHref(node.id, node.category, node.subcategory, node.type),
      },
    });
  }

  // Helper to get correct paths for category nodes
  const getCategoryHref = (cat: Category) => {
    if (cat.type === 'intermediate') {
      return `/ai-transition-model/scenarios/${cat.id}/`;
    } else if (cat.type === 'effect') {
      return `/ai-transition-model/outcomes/${cat.id}/`;
    }
    return `/ai-transition-model/factors/${cat.id}/`;
  };

  const getSubItemPath = (cat: Category, itemId: string) => {
    if (cat.type === 'intermediate') {
      return `/ai-transition-model/scenarios/${cat.id}/${itemId}/`;
    } else if (cat.type === 'effect') {
      return `/ai-transition-model/outcomes/${itemId}/`;
    }
    return `/ai-transition-model/factors/${cat.id}/${itemId}/`;
  };

  // Also add scenario and outcome category nodes themselves
  // These don't have detailed sub-nodes but should appear in the graph
  for (const cat of data.categories) {
    // Only add scenarios (intermediate) and outcomes (effect)
    if (cat.type !== 'intermediate' && cat.type !== 'effect') continue;

    // Check category filter
    if (filters.categories[cat.id] === false) continue;

    // Check type filter
    if (filters.types[cat.type] === false) continue;

    // Get category color
    const categoryColor = CATEGORY_COLORS[cat.id];

    filteredNodeIds.add(cat.id);
    filteredNodes.push({
      id: cat.id,
      type: 'causeEffect' as const,
      position: { x: 0, y: 0 },
      data: {
        label: cat.label,
        description: cat.description || '',
        type: cat.type,
        subgroup: cat.id,
        nodeColors: categoryColor,
        href: getCategoryHref(cat),
        // Include sub-items for scenarios
        subItems: cat.subItems?.map((item) => ({
          label: item.label,
          href: getSubItemPath(cat, item.id),
        })),
      },
    });
  }

  // Filter edges to only include those between visible nodes
  const allEdges: Array<{
    id: string;
    source: string;
    target: string;
    strength: 'strong' | 'medium' | 'weak';
    effect: 'increases' | 'decreases' | 'mixed';
    label?: string;
  }> = [];

  // Add detailed edges
  for (let i = 0; i < data.detailedEdges.length; i++) {
    const edge = data.detailedEdges[i];
    if (filteredNodeIds.has(edge.source) && filteredNodeIds.has(edge.target)) {
      allEdges.push({
        id: `det-${i}-${edge.source}-${edge.target}`,
        source: edge.source,
        target: edge.target,
        strength: edge.strength || 'medium',
        effect: edge.effect || 'increases',
        label: edge.label,
      });
    }
  }

  // Also add category edges (connections between scenarios and outcomes)
  for (let i = 0; i < data.categoryEdges.length; i++) {
    const edge = data.categoryEdges[i];
    if (filteredNodeIds.has(edge.source) && filteredNodeIds.has(edge.target)) {
      // Avoid duplicate edges
      const edgeId = `cat-${i}-${edge.source}-${edge.target}`;
      if (!allEdges.some(e => e.id === edgeId)) {
        allEdges.push({
          id: edgeId,
          source: edge.source,
          target: edge.target,
          strength: edge.strength || 'medium',
          effect: edge.effect || 'increases',
          label: edge.label,
        });
      }
    }
  }

  // Apply edge density filtering
  const edgeDensity = filters.edgeDensity || 'all';
  let filteredEdgeList = allEdges;

  if (edgeDensity !== 'all') {
    // Score edges: strong=3, medium=2, weak=1
    const scoreEdge = (e: typeof allEdges[0]) => {
      const strengthScore = e.strength === 'strong' ? 3 : e.strength === 'medium' ? 2 : 1;
      return strengthScore;
    };

    // Sort by score descending
    const scoredEdges = allEdges.map(e => ({ edge: e, score: scoreEdge(e) }));
    scoredEdges.sort((a, b) => b.score - a.score);

    // Determine how many edges to keep
    const densityPercent = {
      minimal: 0.1,
      low: 0.25,
      medium: 0.5,
      high: 0.75,
      all: 1.0,
    }[edgeDensity];

    const targetCount = Math.ceil(allEdges.length * densityPercent);

    // Track which nodes have at least one connection
    const connectedNodes = new Set<string>();
    const selectedEdges: typeof allEdges = [];

    // First pass: select top edges by score
    for (const { edge } of scoredEdges) {
      if (selectedEdges.length >= targetCount) break;
      selectedEdges.push(edge);
      connectedNodes.add(edge.source);
      connectedNodes.add(edge.target);
    }

    // Second pass: ensure every visible node has at least one edge (if possible)
    const orphanedNodes = new Set<string>();
    filteredNodeIds.forEach(nodeId => {
      if (!connectedNodes.has(nodeId)) {
        orphanedNodes.add(nodeId);
      }
    });

    // Add best edge for each orphaned node
    for (const nodeId of orphanedNodes) {
      const nodeEdges = scoredEdges.filter(
        ({ edge }) => edge.source === nodeId || edge.target === nodeId
      );
      if (nodeEdges.length > 0 && !selectedEdges.includes(nodeEdges[0].edge)) {
        selectedEdges.push(nodeEdges[0].edge);
      }
    }

    filteredEdgeList = selectedEdges;
  }

  // Convert to Edge format
  const filteredEdges: Edge<CauseEffectEdgeData>[] = filteredEdgeList.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    data: {
      strength: e.strength,
      effect: e.effect,
    },
    label: e.label,
  }));

  return { nodes: filteredNodes, edges: filteredEdges };
}

// =============================================================================
// INTERACTIVE VIEW (Options A, B, D)
// Cluster-based view with expandable nodes and rich metadata
// =============================================================================

export interface InteractiveCategory {
  id: string;
  label: string;
  type: 'cause' | 'intermediate' | 'effect';
  description?: string;
  subgroup?: string;
  childCount: number;
  connectionCount: number;
  subItems: Array<{
    id: string;
    label: string;
    childCount: number;
    connectionCount: number;
  }>;
}

export interface InteractiveViewData {
  categories: InteractiveCategory[];
  categoryEdges: Array<{
    source: string;
    target: string;
    strength: 'weak' | 'medium' | 'strong';
    effect: 'increases' | 'decreases' | 'mixed';
  }>;
}

/**
 * Get data for the interactive view
 * Returns categories with rich metadata for clustering
 */
export function getInteractiveViewData(): InteractiveViewData {
  const data = getData();

  // Count connections per node
  const connectionCounts = new Map<string, number>();
  for (const edge of data.detailedEdges) {
    connectionCounts.set(edge.source, (connectionCounts.get(edge.source) || 0) + 1);
    connectionCounts.set(edge.target, (connectionCounts.get(edge.target) || 0) + 1);
  }

  // Count nodes per category and subcategory
  const categoryChildCounts = new Map<string, number>();
  const subcategoryChildCounts = new Map<string, number>();

  for (const node of data.detailedNodes) {
    categoryChildCounts.set(
      node.category,
      (categoryChildCounts.get(node.category) || 0) + 1
    );
    if (node.subcategory) {
      const subKey = `${node.category}--${node.subcategory}`;
      subcategoryChildCounts.set(subKey, (subcategoryChildCounts.get(subKey) || 0) + 1);
    }
  }

  // Sum connections per category
  const categoryConnectionCounts = new Map<string, number>();
  for (const node of data.detailedNodes) {
    const count = connectionCounts.get(node.id) || 0;
    categoryConnectionCounts.set(
      node.category,
      (categoryConnectionCounts.get(node.category) || 0) + count
    );
  }

  // Build categories with rich metadata
  const categories: InteractiveCategory[] = data.categories.map((cat) => ({
    id: cat.id,
    label: cat.label,
    type: cat.type,
    description: cat.description,
    subgroup: cat.subgroup,
    childCount: categoryChildCounts.get(cat.id) || 0,
    connectionCount: categoryConnectionCounts.get(cat.id) || 0,
    subItems: (cat.subItems || []).map((sub) => {
      const subKey = `${cat.id}--${sub.id}`;
      return {
        id: sub.id,
        label: sub.label,
        childCount: subcategoryChildCounts.get(subKey) || 0,
        connectionCount: 0, // Could calculate this more granularly
      };
    }),
  }));

  // Category edges with metadata
  const categoryEdges = data.categoryEdges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    strength: edge.strength || 'medium',
    effect: edge.effect || 'increases',
  }));

  return { categories, categoryEdges };
}

/**
 * Get nodes for interactive cluster view
 * Returns cluster nodes (collapsed categories) with expandable subcategories
 * When expanded, also includes a container node that visually groups the subcategories
 */
export function getInteractiveNodes(
  expandedCategories: Set<string>,
  onCollapseCategory?: (categoryId: string) => void
): Node<CauseEffectNodeData>[] {
  const data = getData();
  const interactiveData = getInteractiveViewData();
  const nodes: Node<CauseEffectNodeData>[] = [];

  for (const cat of interactiveData.categories) {
    const isExpanded = expandedCategories.has(cat.id);

    if (cat.type === 'cause') {
      // Root factors: show as cluster that can expand to show subcategories
      if (isExpanded && cat.subItems.length > 0) {
        // Show subcategories as separate expandable nodes
        // First node in the group gets a collapse button to re-combine
        for (let i = 0; i < cat.subItems.length; i++) {
          const subItem = cat.subItems[i];
          const isFirstInGroup = i === 0;
          nodes.push({
            id: `${cat.id}--${subItem.id}`,
            type: 'expandable' as const,
            position: { x: 0, y: 0 },
            data: {
              label: subItem.label,
              type: 'cause',
              subgroup: cat.id,  // Use category ID as subgroup for layout grouping
              childCount: subItem.childCount,
              connectionCount: subItem.connectionCount,
              isExpandable: subItem.childCount > 0,
              clusterLabel: cat.label,
              // First node in group shows collapse button
              showCollapseButton: isFirstInGroup,
              onCollapse: isFirstInGroup && onCollapseCategory ? () => onCollapseCategory(cat.id) : undefined,
              groupSize: cat.subItems.length,
              href: `/ai-transition-model/factors/${cat.id}/${subItem.id}/`,
            } as CauseEffectNodeData,
          });
        }
      } else {
        // Show as collapsed cluster
        nodes.push({
          id: cat.id,
          type: 'cluster' as const,
          position: { x: 0, y: 0 },
          data: {
            label: cat.label,
            description: cat.description,
            type: 'cause',
            subgroup: cat.subgroup,
            childCount: cat.subItems.length,
            previewItems: cat.subItems.slice(0, 4).map((s) => s.label),
            isExpanded,
            href: `/ai-transition-model/factors/${cat.id}/`,
          } as CauseEffectNodeData,
        });
      }
    } else {
      // Scenarios and outcomes: always show as regular nodes
      // Helper to get correct path based on category type
      const getSubItemPath = (itemId: string) => {
        if (cat.type === 'intermediate') {
          return `/ai-transition-model/scenarios/${cat.id}/${itemId}/`;
        } else if (cat.type === 'effect') {
          return `/ai-transition-model/outcomes/${itemId}/`;
        }
        return `/ai-transition-model/factors/${cat.id}/${itemId}/`;
      };
      const getCategoryHref = () => {
        if (cat.type === 'intermediate') {
          return `/ai-transition-model/scenarios/${cat.id}/`;
        } else if (cat.type === 'effect') {
          return `/ai-transition-model/outcomes/${cat.id}/`;
        }
        return `/ai-transition-model/factors/${cat.id}/`;
      };

      nodes.push({
        id: cat.id,
        type: 'causeEffect' as const,
        position: { x: 0, y: 0 },
        data: {
          label: cat.label,
          description: cat.description,
          type: cat.type,
          subgroup: cat.subgroup,
          href: getCategoryHref(),
          subItems: cat.subItems.map((s) => ({
            label: s.label,
            href: getSubItemPath(s.id),
          })),
        },
      });
    }
  }

  return nodes;
}

/**
 * Get edges for interactive view
 * Adjusts edges based on which categories are expanded
 */
export function getInteractiveEdges(
  expandedCategories: Set<string>
): Edge<CauseEffectEdgeData>[] {
  const data = getData();
  const edges: Edge<CauseEffectEdgeData>[] = [];
  const nodeIds = new Set(getInteractiveNodes(expandedCategories).map((n) => n.id));

  for (const catEdge of data.categoryEdges) {
    const sourceCat = data.categories.find((c) => c.id === catEdge.source);
    const targetCat = data.categories.find((c) => c.id === catEdge.target);

    if (!sourceCat || !targetCat) continue;

    const sourceExpanded = expandedCategories.has(catEdge.source);

    if (sourceExpanded && sourceCat.subItems && sourceCat.type === 'cause') {
      // Connect each subcategory to target
      for (const subItem of sourceCat.subItems) {
        const sourceId = `${catEdge.source}--${subItem.id}`;
        if (nodeIds.has(sourceId) && nodeIds.has(catEdge.target)) {
          edges.push({
            id: `int-${sourceId}-${catEdge.target}`,
            source: sourceId,
            target: catEdge.target,
            data: {
              strength: catEdge.strength || 'medium',
              effect: catEdge.effect || 'increases',
            },
          });
        }
      }
    } else {
      // Keep edge at category level
      if (nodeIds.has(catEdge.source) && nodeIds.has(catEdge.target)) {
        edges.push({
          id: `int-cat-${catEdge.source}-${catEdge.target}`,
          source: catEdge.source,
          target: catEdge.target,
          data: {
            strength: catEdge.strength || 'medium',
            effect: catEdge.effect || 'increases',
          },
        });
      }
    }
  }

  return edges;
}

// =============================================================================
// AUTO-SUBGRAPH EXTRACTION FOR ENTITY PAGES
// =============================================================================

/**
 * Generate an entity-specific diagram from the master graph.
 *
 * This extracts a relevant subgraph centered around a specific entity,
 * showing its causes, effects, and related nodes.
 *
 * @param entityId - The entity ID (e.g., 'compute', 'algorithms', 'ai-capabilities')
 * @param maxNodes - Maximum nodes to include (default 15)
 */
export function getEntitySubgraph(
  entityId: string,
  maxNodes: number = 15
): {
  nodes: Node<CauseEffectNodeData>[];
  edges: Edge<CauseEffectEdgeData>[];
  primaryNodeId?: string;
} | null {
  const data = getData();

  // Check if entity is a category (root factor)
  const category = data.categories.find((c) => c.id === entityId);
  if (category) {
    return getCategorySubgraph(entityId, maxNodes);
  }

  // Check if entity is a sub-item
  for (const cat of data.categories) {
    const subItem = cat.subItems?.find((s) => s.id === entityId);
    if (subItem) {
      return getSubItemSubgraph(cat.id, entityId, maxNodes);
    }
  }

  // Check if entity matches a subcategory in detailed nodes
  const nodesForEntity = data.detailedNodes.filter((n) => n.subcategory === entityId);
  if (nodesForEntity.length > 0) {
    return getSubcategorySubgraph(entityId, maxNodes);
  }

  return null;
}

/**
 * Get a subgraph for a root category (e.g., ai-capabilities)
 */
function getCategorySubgraph(
  categoryId: string,
  maxNodes: number
): { nodes: Node<CauseEffectNodeData>[]; edges: Edge<CauseEffectEdgeData>[]; primaryNodeId?: string } {
  const data = getData();
  const category = data.categories.find((c) => c.id === categoryId);
  if (!category) return { nodes: [], edges: [] };

  const nodes: Node<CauseEffectNodeData>[] = [];
  const edges: Edge<CauseEffectEdgeData>[] = [];
  const nodeIds = new Set<string>();

  // Helper to get href for a node
  const getHref = (cat: Category, subItemId?: string) => {
    if (cat.type === 'intermediate') {
      return subItemId
        ? `/ai-transition-model/scenarios/${cat.id}/${subItemId}/`
        : `/ai-transition-model/scenarios/${cat.id}/`;
    } else if (cat.type === 'effect') {
      return subItemId
        ? `/ai-transition-model/outcomes/${subItemId}/`
        : `/ai-transition-model/outcomes/${cat.id}/`;
    }
    return subItemId
      ? `/ai-transition-model/factors/${cat.id}/${subItemId}/`
      : `/ai-transition-model/factors/${cat.id}/`;
  };

  // Add the main category node
  nodes.push({
    id: categoryId,
    type: 'causeEffect',
    position: { x: 0, y: 0 },
    data: {
      label: category.label,
      description: category.description || '',
      type: category.type,
      subgroup: category.subgroup,
      href: getHref(category),
    },
  });
  nodeIds.add(categoryId);

  // Add sub-items as nodes (limited)
  const subItemLimit = Math.min((category.subItems?.length || 0), Math.floor(maxNodes / 2));
  for (let i = 0; i < subItemLimit && category.subItems; i++) {
    const subItem = category.subItems[i];
    const subItemNodeId = `${categoryId}--${subItem.id}`;
    nodes.push({
      id: subItemNodeId,
      type: 'causeEffect',
      position: { x: 0, y: 0 },
      data: {
        label: subItem.label,
        type: 'cause',
        subgroup: categoryId,
        href: getHref(category, subItem.id),
      },
    });
    nodeIds.add(subItemNodeId);

    // Edge from sub-item to category
    edges.push({
      id: `sub-${subItemNodeId}-${categoryId}`,
      source: subItemNodeId,
      target: categoryId,
      data: { strength: 'medium', effect: 'increases' },
    });
  }

  // Find connected scenarios and outcomes
  for (const catEdge of data.categoryEdges) {
    if (catEdge.source === categoryId && nodes.length < maxNodes) {
      const targetCat = data.categories.find((c) => c.id === catEdge.target);
      if (targetCat && !nodeIds.has(catEdge.target)) {
        nodes.push({
          id: catEdge.target,
          type: 'causeEffect',
          position: { x: 0, y: 0 },
          data: {
            label: targetCat.label,
            description: targetCat.description || '',
            type: targetCat.type,
            subgroup: targetCat.subgroup,
            href: getHref(targetCat),
          },
        });
        nodeIds.add(catEdge.target);

        edges.push({
          id: `cat-${catEdge.source}-${catEdge.target}`,
          source: catEdge.source,
          target: catEdge.target,
          data: {
            strength: catEdge.strength || 'medium',
            effect: catEdge.effect || 'increases',
          },
        });
      }
    }
  }

  return { nodes, edges, primaryNodeId: categoryId };
}

/**
 * Get a subgraph for a sub-item (e.g., compute within ai-capabilities)
 */
function getSubItemSubgraph(
  categoryId: string,
  subItemId: string,
  maxNodes: number
): { nodes: Node<CauseEffectNodeData>[]; edges: Edge<CauseEffectEdgeData>[]; primaryNodeId?: string } {
  const data = getData();
  const nodes: Node<CauseEffectNodeData>[] = [];
  const edges: Edge<CauseEffectEdgeData>[] = [];
  const nodeIds = new Set<string>();

  // Find all detailed nodes for this subcategory
  const detailedForSubItem = data.detailedNodes.filter(
    (n) => n.category === categoryId && n.subcategory === subItemId
  );

  // Get category info
  const category = data.categories.find((c) => c.id === categoryId);
  if (!category) return { nodes: [], edges: [] };

  const subItem = category.subItems?.find((s) => s.id === subItemId);
  if (!subItem) return { nodes: [], edges: [] };

  // Create central node for this sub-item
  const centralNodeId = `${categoryId}--${subItemId}`;
  nodes.push({
    id: centralNodeId,
    type: 'causeEffect',
    position: { x: 0, y: 0 },
    data: {
      label: subItem.label,
      type: 'intermediate',
      subgroup: categoryId,
      href: `/ai-transition-model/factors/${categoryId}/${subItemId}/`,
    },
  });
  nodeIds.add(centralNodeId);

  // Add detailed nodes as causes (limited)
  const detailedLimit = Math.min(detailedForSubItem.length, maxNodes - 3);
  for (let i = 0; i < detailedLimit; i++) {
    const detailed = detailedForSubItem[i];
    nodes.push({
      id: detailed.id,
      type: 'causeEffect',
      position: { x: 0, y: 0 },
      data: {
        label: detailed.label,
        description: detailed.description || '',
        type: 'cause',
        subgroup: detailed.category,
      },
    });
    nodeIds.add(detailed.id);

    // Edge from detailed to central
    edges.push({
      id: `det-${detailed.id}-${centralNodeId}`,
      source: detailed.id,
      target: centralNodeId,
      data: { strength: 'medium', effect: 'increases' },
    });
  }

  // Add the parent category as an effect
  if (nodes.length < maxNodes) {
    nodes.push({
      id: categoryId,
      type: 'causeEffect',
      position: { x: 0, y: 0 },
      data: {
        label: category.label,
        type: 'effect',
        subgroup: category.subgroup,
        href: `/ai-transition-model/factors/${categoryId}/`,
      },
    });
    nodeIds.add(categoryId);

    edges.push({
      id: `sub-${centralNodeId}-${categoryId}`,
      source: centralNodeId,
      target: categoryId,
      data: { strength: 'strong', effect: 'increases' },
    });
  }

  // Add connected scenarios if space remains
  for (const catEdge of data.categoryEdges) {
    if (catEdge.source === categoryId && nodes.length < maxNodes) {
      const targetCat = data.categories.find((c) => c.id === catEdge.target);
      if (targetCat && targetCat.type === 'intermediate' && !nodeIds.has(catEdge.target)) {
        nodes.push({
          id: catEdge.target,
          type: 'causeEffect',
          position: { x: 0, y: 0 },
          data: {
            label: targetCat.label,
            type: 'effect',
            subgroup: targetCat.subgroup,
            href: `/ai-transition-model/scenarios/${catEdge.target}/`,
          },
        });
        nodeIds.add(catEdge.target);

        edges.push({
          id: `cat-${categoryId}-${catEdge.target}`,
          source: categoryId,
          target: catEdge.target,
          data: {
            strength: catEdge.strength || 'medium',
            effect: catEdge.effect || 'increases',
          },
        });
      }
    }
  }

  return { nodes, edges, primaryNodeId: centralNodeId };
}

/**
 * Get a subgraph for a subcategory (using detailed nodes)
 */
function getSubcategorySubgraph(
  subcategoryId: string,
  maxNodes: number
): { nodes: Node<CauseEffectNodeData>[]; edges: Edge<CauseEffectEdgeData>[]; primaryNodeId?: string } {
  const data = getData();
  const nodes: Node<CauseEffectNodeData>[] = [];
  const edges: Edge<CauseEffectEdgeData>[] = [];
  const nodeIds = new Set<string>();

  // Find all detailed nodes for this subcategory
  const detailedForSubcat = data.detailedNodes.filter((n) => n.subcategory === subcategoryId);
  if (detailedForSubcat.length === 0) return { nodes, edges };

  // Add detailed nodes
  const limit = Math.min(detailedForSubcat.length, maxNodes);
  for (let i = 0; i < limit; i++) {
    const detailed = detailedForSubcat[i];
    nodes.push({
      id: detailed.id,
      type: 'causeEffect',
      position: { x: 0, y: 0 },
      data: {
        label: detailed.label,
        description: detailed.description || '',
        type: detailed.type === 'leaf' ? 'cause' : detailed.type,
        subgroup: detailed.category,
      },
    });
    nodeIds.add(detailed.id);
  }

  // Add edges between these nodes based on detailed edges
  for (const edge of data.detailedEdges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      edges.push({
        id: `det-${edge.source}-${edge.target}`,
        source: edge.source,
        target: edge.target,
        data: {
          strength: edge.strength || 'medium',
          effect: edge.effect || 'increases',
        },
      });
    }
  }

  return { nodes, edges, primaryNodeId: detailedForSubcat[0]?.id };
}

/**
 * Check if an entity has a subgraph available
 */
export function hasEntitySubgraph(entityId: string): boolean {
  const data = getData();

  // Check if it's a category
  if (data.categories.some((c) => c.id === entityId)) {
    return true;
  }

  // Check if it's a sub-item
  for (const cat of data.categories) {
    if (cat.subItems?.some((s) => s.id === entityId)) {
      return true;
    }
  }

  // Check if it's a subcategory with detailed nodes
  if (data.detailedNodes.some((n) => n.subcategory === entityId)) {
    return true;
  }

  return false;
}
