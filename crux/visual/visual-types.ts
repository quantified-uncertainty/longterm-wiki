/**
 * Visual Pipeline - Types
 *
 * Pipeline-specific types (review results, audit coverage, generatable
 * types, component map) live here. Canonical types (VisualType,
 * VisualDefinition, VISUAL_COMPONENT_NAMES) live in data/schema.ts.
 * Detection utilities live in crux/lib/visual-detection.ts.
 *
 * Import guidelines:
 *   - Canonical types:  import from 'data/schema.ts'
 *   - Detection:        import from 'crux/lib/visual-detection.ts'
 *   - Pipeline types:   import from here (visual-types.ts)
 */

import type { VisualCounts } from '../lib/visual-detection.ts';

// Re-export types that pipeline scripts need alongside pipeline types
export type { VisualType, VisualDefinition } from '../../data/schema.ts';
export type { VisualCounts, ExtractedVisual } from '../lib/visual-detection.ts';
export { countVisuals, extractVisuals } from '../lib/visual-detection.ts';

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
  visuals: VisualCounts;
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
