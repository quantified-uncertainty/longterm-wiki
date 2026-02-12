/**
 * Visual Pipeline - Types
 *
 * Re-exports canonical types from data/schema.ts and shared detection
 * from crux/lib/visual-detection.ts. Pipeline-specific types (review
 * results, audit coverage, etc.) are defined here.
 *
 * The canonical VisualType enum and VISUAL_COMPONENT_NAMES live in
 * data/schema.ts so that both the app and crux can use them.
 */

// ============================================================================
// Re-exports from canonical sources
// ============================================================================

// Canonical visual type enum (from data/schema.ts)
export type { VisualType, VisualDefinition } from '../../data/schema.ts';
export { VisualType as VisualTypeEnum, VISUAL_COMPONENT_NAMES } from '../../data/schema.ts';

// Shared detection (from crux/lib/visual-detection.ts)
export {
  countVisuals,
  countDiagrams,
  countTables,
  extractVisuals,
  type VisualCounts,
  type ExtractedVisual,
} from '../lib/visual-detection.ts';

// ============================================================================
// Generatable visual types (subset that the visual pipeline can create)
// These exclude markdown-table and table-view which are created differently.
// ============================================================================

export const GENERATABLE_VISUAL_TYPES = [
  'mermaid',
  'squiggle',
  'cause-effect',
  'comparison',
  'disagreement',
] as const;

export type GeneratableVisualType = (typeof GENERATABLE_VISUAL_TYPES)[number];

export function isGeneratableVisualType(value: string): value is GeneratableVisualType {
  return GENERATABLE_VISUAL_TYPES.includes(value as GeneratableVisualType);
}

// ============================================================================
// Component mapping for generation (import statements and props)
// Only for generatable types — used by visual-create and visual-embed.
// ============================================================================

export const VISUAL_COMPONENT_MAP: Record<
  GeneratableVisualType,
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
    'table-view': number;
    'markdown-table': number;
    total: number;
  };
  needsVisuals: boolean;
  suggestedTypes: GeneratableVisualType[];
}

// ============================================================================
// Review types
// ============================================================================

export interface VisualReviewResult {
  pageId: string;
  visualIndex: number;
  type: string;
  syntaxIssues: SyntaxIssue[];
  qualityReview?: QualityReview;
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
  type: GeneratableVisualType;
  directions?: string;
  model?: string;
  dryRun?: boolean;
  output?: string;
}

export interface VisualCreateResult {
  type: GeneratableVisualType;
  component: string;
  code: string;
  mdxSnippet: string;
  importStatement: string;
}
