/**
 * Visual Pipeline - Shared Types
 *
 * Type definitions for the visual creation, review, and management pipeline.
 */

// ============================================================================
// Visual types supported by the pipeline
// ============================================================================

export const VISUAL_TYPES = [
  'mermaid',
  'squiggle',
  'cause-effect',
  'comparison',
  'disagreement',
] as const;

export type VisualType = (typeof VISUAL_TYPES)[number];

export function isVisualType(value: string): value is VisualType {
  return VISUAL_TYPES.includes(value as VisualType);
}

// ============================================================================
// Component mapping for each visual type
// ============================================================================

export const VISUAL_COMPONENT_MAP: Record<
  VisualType,
  { component: string; import: string; propsType: string }
> = {
  mermaid: {
    component: 'MermaidDiagram',
    import: "import { MermaidDiagram } from '@components/wiki/MermaidDiagram';",
    propsType: 'chart: string',
  },
  squiggle: {
    component: 'SquiggleEstimate',
    import: "import { SquiggleEstimate } from '@components/wiki/SquiggleEstimate';",
    propsType: 'title: string, code: string',
  },
  'cause-effect': {
    component: 'CauseEffectGraph',
    import: "import { CauseEffectGraph } from '@components/wiki/CauseEffectGraph';",
    propsType: 'initialNodes: Node[], initialEdges: Edge[]',
  },
  comparison: {
    component: 'ComparisonTable',
    import: "import { ComparisonTable } from '@components/wiki/ComparisonTable';",
    propsType: 'title: string, columns: string[], rows: ComparisonRow[]',
  },
  disagreement: {
    component: 'DisagreementMap',
    import: "import { DisagreementMap } from '@components/wiki/DisagreementMap';",
    propsType: 'topic: string, positions: Position[]',
  },
};

// ============================================================================
// Detection patterns for finding visuals in MDX content
// ============================================================================

export const VISUAL_DETECTION_PATTERNS: Record<VisualType, RegExp[]> = {
  mermaid: [
    /<MermaidDiagram[\s>]/g,
    /<Mermaid[\s>]/g,
    /<Mermaid\s+client:load/g,
  ],
  squiggle: [/<SquiggleEstimate[\s>]/g],
  'cause-effect': [
    /<CauseEffectGraph[\s>]/g,
    /<PageCauseEffectGraph[\s>]/g,
  ],
  comparison: [/<ComparisonTable[\s>]/g],
  disagreement: [/<DisagreementMap[\s>]/g],
};

// ============================================================================
// Visual data model for reusable/referenced visuals
// ============================================================================

export interface VisualDefinition {
  /** Unique identifier for this visual */
  id: string;
  /** Human-readable title */
  title: string;
  /** Visual type */
  type: VisualType;
  /** Description of what this visual shows */
  description?: string;
  /** Page IDs where this visual is used */
  usedIn: string[];
  /** Tags for categorization */
  tags?: string[];
  /** The visual content (Mermaid code, Squiggle code, or JSON data) */
  content: string;
  /** Props to pass to the component (JSON) */
  props?: Record<string, unknown>;
  /** Quality score from last review (0-100) */
  quality?: number;
  /** Last review date */
  lastReviewed?: string;
  /** Review notes from last AI review */
  reviewNotes?: string[];
}

// ============================================================================
// Audit types
// ============================================================================

export interface PageVisualCoverage {
  pageId: string;
  pagePath: string;
  title: string;
  wordCount: number;
  quality?: number;
  importance?: number;
  visuals: {
    mermaid: number;
    squiggle: number;
    'cause-effect': number;
    comparison: number;
    disagreement: number;
    total: number;
  };
  /** Whether this page should have visuals based on word count and importance */
  needsVisuals: boolean;
  /** Suggested visual types based on content analysis */
  suggestedTypes: VisualType[];
}

// ============================================================================
// Review types
// ============================================================================

export interface VisualReviewResult {
  pageId: string;
  visualIndex: number;
  type: VisualType;
  /** Static analysis issues */
  syntaxIssues: SyntaxIssue[];
  /** AI quality review (if screenshot was taken) */
  qualityReview?: QualityReview;
  /** Screenshot path (if taken) */
  screenshotPath?: string;
}

export interface SyntaxIssue {
  severity: 'error' | 'warning';
  message: string;
  line?: number;
  fix?: string;
}

export interface QualityReview {
  score: number;
  strengths: string[];
  issues: string[];
  suggestions: string[];
}

// ============================================================================
// Create/Improve pipeline types
// ============================================================================

export interface VisualCreateOptions {
  pageId: string;
  type: VisualType;
  directions?: string;
  model?: string;
  dryRun?: boolean;
  output?: string;
}

export interface VisualCreateResult {
  type: VisualType;
  component: string;
  code: string;
  /** Full MDX snippet ready to paste into page */
  mdxSnippet: string;
  /** Import statement needed */
  importStatement: string;
}
