// Types for CauseEffectGraph

// Color override for nodes - allows explicit color customization
export interface NodeColors {
  bg?: string;
  border?: string;
  text?: string;
  accent?: string;
}

// Scoring dimensions for cause-effect graph nodes (all 1-10 scale)
export interface NodeScores {
  novelty?: number;        // How novel/interesting to a recent reader (1=common knowledge, 10=very surprising)
  sensitivity?: number;    // How much downstream nodes change if this changes (1=minimal impact, 10=huge cascading effects)
  changeability?: number;  // How tractable/changeable is this factor (1=fixed, 10=highly malleable)
  certainty?: number;      // How well understood/certain are we (1=highly uncertain, 10=well established)
}

export interface CauseEffectNodeData extends Record<string, unknown> {
  label: string;
  description?: string;
  type?: 'leaf' | 'cause' | 'effect' | 'intermediate';
  subgroup?: string;
  order?: number;  // Manual ordering within layer (0 = leftmost)
  color?: string;  // Semantic color name (e.g., "rose", "violet", "teal") - maps to predefined palette
  nodeColors?: NodeColors;  // Optional explicit color override (hex values) - takes priority over color
  subItems?: Array<{
    label: string;
    probability?: string;
    href?: string;
    entityId?: string;  // Entity ID for rich tooltip lookups
    description?: string;
    scope?: string;
    ratings?: {
      changeability?: number;
      xriskImpact?: number;
      trajectoryImpact?: number;
      uncertainty?: number;
    };
    keyDebates?: Array<{ topic: string; description: string }>;
  }>;
  confidence?: number;
  confidenceLabel?: string;
  details?: string;
  sources?: string[];
  relatedConcepts?: string[];
  href?: string;  // URL to navigate to when node is clicked
  suppressNavigation?: boolean;  // When true, clicking the node won't navigate (allows path highlighting/details panel to work instead)
  scores?: NodeScores;  // Scoring dimensions for node
  scoreIntensity?: number;  // Computed score intensity (0-1) for highlighting, -1 = no score
  highlightColor?: 'purple' | 'red' | 'green' | 'blue' | 'yellow';  // Color for score highlighting
  activeScoreDimension?: 'sensitivity' | 'novelty' | 'changeability' | 'certainty';  // Which score is being highlighted
  showScores?: boolean;  // Whether to display score indicators on the node
}

export interface CauseEffectEdgeData extends Record<string, unknown> {
  label?: string;
  impact?: number;
  strength?: 'strong' | 'medium' | 'weak';
  confidence?: 'high' | 'medium' | 'low';
  effect?: 'increases' | 'decreases' | 'mixed';
}

// Layout configuration options (all optional, with sensible defaults)
export interface LayoutOptions {
  containerWidth?: number;      // Fixed width for group containers
  centerX?: number;             // Center point for layout
  layerGap?: number;            // Vertical gap between layers
  causeSpacing?: number;        // Extra horizontal spacing for cause nodes
  intermediateSpacing?: number; // Extra horizontal spacing for intermediate nodes
  effectSpacing?: number;       // Extra horizontal spacing for effect nodes
}

// Type labels for customizing group/legend names
export interface TypeLabels {
  cause?: string;
  intermediate?: string;
  effect?: string;
  leaf?: string;
}

// Subgroup configuration (for nested groupings within layers)
export interface SubgroupConfig {
  label: string;
  bgColor: string;
  borderColor: string;
}

// Custom legend item
export interface LegendItem {
  type: string;
  label: string;
  color: string;
  borderColor: string;
}

// ELK layout options
export interface ElkLayoutOptions {
  edgeRouting?: 'POLYLINE' | 'SPLINES' | 'ORTHOGONAL';
  nodeSpacing?: number;
  layerSpacing?: number;
}

// Layout algorithm type
export type LayoutAlgorithm = 'dagre' | 'grouped' | 'elk';

// Complete graph configuration (combines all customization options)
export interface GraphConfig {
  layout?: LayoutOptions;
  typeLabels?: TypeLabels;
  subgroups?: Record<string, SubgroupConfig>;
  legendItems?: LegendItem[];
  elkOptions?: ElkLayoutOptions;
  // Visual options
  hideGroupBackgrounds?: boolean;  // Don't show section backgrounds (CAUSES, INTERMEDIATE, EFFECTS)
  hideGroupLabels?: boolean;       // Don't show section labels
  compactMode?: boolean;           // Use tighter spacing in layouts (default true)
  straightEdges?: boolean;         // Use straight edges instead of curved splines (default false)
  nodeWidth?: number;              // Node width in pixels (default 180)
  // Layout algorithm
  useDagre?: boolean;              // Use Dagre instead of ELK for simpler, cleaner layouts (deprecated - use layoutAlgorithm)
  layoutAlgorithm?: LayoutAlgorithm; // Layout algorithm to use: 'dagre' (hierarchical), 'grouped' (category sections), 'elk' (layered)
}
