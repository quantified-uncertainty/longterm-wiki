// Configuration and constants for CauseEffectGraph

// Node dimensions for layout calculation
export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 80;
export const NODE_HEIGHT_WITH_SUBITEMS = 160; // Nodes with 3 subItems are ~160px tall

// Group container padding and spacing
export const GROUP_PADDING = 20;
export const GROUP_HEADER_HEIGHT = 28;

// Subgroup padding and spacing
export const SUBGROUP_PADDING = 12;
export const SUBGROUP_HEADER_HEIGHT = 20;
export const SUBGROUP_GAP = 15;

// Unified configuration for all node types
export interface NodeTypeConfig {
  label: string;
  // Container (group) styling
  groupBg: string;
  groupBorder: string;
  // Node styling
  nodeBg: string;
  nodeBorder: string;
  nodeText: string;
  nodeAccent: string;
  // Legend
  showInLegend: boolean;
  legendOrder: number;
}

// Default labels (generic) - can be overridden via GraphConfig.typeLabels
export const DEFAULT_TYPE_LABELS: Record<string, string> = {
  leaf: 'Leaf Nodes',
  cause: 'Causes',
  intermediate: 'Intermediate',
  effect: 'Effects',
};

export const NODE_TYPE_CONFIG: Record<string, NodeTypeConfig> = {
  // Root inputs - White bg with teal border
  leaf: {
    label: DEFAULT_TYPE_LABELS.leaf,
    groupBg: 'transparent',
    groupBorder: 'transparent',
    nodeBg: '#ffffff',
    nodeBorder: '#14b8a6',  // teal-500
    nodeText: '#334155',  // slate-700 (darker)
    nodeAccent: '#14b8a6',
    showInLegend: true,
    legendOrder: 0,
  },
  // Derived factors - White bg with blue border
  cause: {
    label: DEFAULT_TYPE_LABELS.cause,
    groupBg: 'transparent',
    groupBorder: 'transparent',
    nodeBg: '#ffffff',
    nodeBorder: '#3b82f6',  // blue-500
    nodeText: '#334155',  // slate-700 (darker)
    nodeAccent: '#3b82f6',
    showInLegend: true,
    legendOrder: 1,
  },
  // Direct factors - White bg with slate border
  intermediate: {
    label: DEFAULT_TYPE_LABELS.intermediate,
    groupBg: 'transparent',
    groupBorder: 'transparent',
    nodeBg: '#ffffff',
    nodeBorder: '#64748b',  // slate-500
    nodeText: '#334155',  // slate-700 (darker)
    nodeAccent: '#64748b',
    showInLegend: true,
    legendOrder: 2,
  },
  // Target - White bg with amber border
  effect: {
    label: DEFAULT_TYPE_LABELS.effect,
    groupBg: 'transparent',
    groupBorder: 'transparent',
    nodeBg: '#ffffff',
    nodeBorder: '#f59e0b',  // amber-500
    nodeText: '#334155',  // slate-700 (darker)
    nodeAccent: '#f59e0b',
    showInLegend: true,
    legendOrder: 3,
  },
};

// Special colors for individual outcome nodes (tier-based: differentiate by valence)
export const OUTCOME_COLORS: Record<string, Partial<NodeTypeConfig>> = {
  'existential-catastrophe': {
    nodeBg: '#ffffff',
    nodeBorder: '#ef4444',  // red-500
    nodeText: '#334155',  // slate-700 (darker)
    nodeAccent: '#ef4444',
  },
  'long-term-trajectory': {
    nodeBg: '#ffffff',
    nodeBorder: '#f59e0b',  // amber-500
    nodeText: '#334155',  // slate-700 (darker)
    nodeAccent: '#fbbf24',
  },
};

// Border radius by node type (shapes encode node function)
export const NODE_BORDER_RADIUS: Record<string, string> = {
  leaf: '12px',
  cause: '12px',           // Standard rectangles for factors
  intermediate: '20px',    // More rounded for scenarios (mechanisms)
  effect: '40px',          // Stadium/pill shape for outcomes (terminals)
};

// Derived groupConfig for layout code
export const groupConfig: Record<string, { label: string; bgColor: string; borderColor: string }> =
  Object.fromEntries(
    Object.entries(NODE_TYPE_CONFIG).map(([key, config]) => [
      key,
      { label: config.label, bgColor: config.groupBg, borderColor: config.groupBorder }
    ])
  );

// Default subgroup configuration (empty - graphs provide their own via GraphConfig)
export const DEFAULT_SUBGROUP_CONFIG: Record<string, { label: string; bgColor: string; borderColor: string }> = {};

// Default subgroup order (empty - graphs provide their own)
export const DEFAULT_SUBGROUP_ORDER: string[] = [];

// ELK layout options - compact spacing for cleaner graphs
export const elkOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.spacing.nodeNode': '5',
  'elk.spacing.edgeEdge': '5',
  'elk.spacing.edgeNode': '5',
  'elk.layered.spacing.nodeNodeBetweenLayers': '20',
  'elk.layered.spacing.edgeNodeBetweenLayers': '5',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '5',
  'elk.edgeRouting': 'SPLINES',
  'elk.layered.mergeEdges': 'false',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
};
