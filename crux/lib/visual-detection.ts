/**
 * Visual Detection Module
 *
 * Single source of truth for detecting and counting visual elements in MDX content.
 * Used by:
 *   - metrics-extractor.ts (page quality scoring)
 *   - visual pipeline (review, audit, improve)
 *   - page templates (quality criteria checks)
 *
 * Imports the canonical VisualType and VISUAL_COMPONENT_NAMES from data/schema.ts.
 */

import { VISUAL_COMPONENT_NAMES } from '../../data/schema.ts';
import { getLineNumber } from './mdx-utils.ts';

export type { VisualType } from '../../data/schema.ts';

// ============================================================================
// Detection patterns — built from the canonical component name list
// ============================================================================

/**
 * Regex patterns for detecting each visual type in MDX content.
 * These are derived from VISUAL_COMPONENT_NAMES in schema.ts.
 */
function buildComponentPatterns(): Record<string, RegExp[]> {
  const patterns: Record<string, RegExp[]> = {};
  for (const [type, names] of Object.entries(VISUAL_COMPONENT_NAMES)) {
    patterns[type] = names.map(
      (name) => new RegExp(`<${name}[\\s>]`, 'g'),
    );
  }
  return patterns;
}

const COMPONENT_PATTERNS = buildComponentPatterns();

/** Pattern for markdown table separator rows (| --- | --- |) */
const MARKDOWN_TABLE_PATTERN = /^\|[\s-:|]+\|$/gm;

/** Mermaid code blocks (```mermaid) — also count as mermaid visuals */
const MERMAID_CODE_BLOCK_PATTERN = /```mermaid/g;

// ============================================================================
// Per-type counting
// ============================================================================

export interface VisualCounts {
  mermaid: number;
  squiggle: number;
  'cause-effect': number;
  comparison: number;
  disagreement: number;
  'table-view': number;
  'markdown-table': number;
  /** Sum of all visual elements */
  total: number;
}

/**
 * Count all visual elements in MDX content, broken down by type.
 * This is the canonical counting function — used by metrics-extractor
 * and the visual pipeline.
 */
export function countVisuals(content: string): VisualCounts {
  const counts: VisualCounts = {
    mermaid: 0,
    squiggle: 0,
    'cause-effect': 0,
    comparison: 0,
    disagreement: 0,
    'table-view': 0,
    'markdown-table': 0,
    total: 0,
  };

  // Count JSX component-based visuals
  for (const [type, patterns] of Object.entries(COMPONENT_PATTERNS)) {
    for (const pattern of patterns) {
      // Reset lastIndex for global regexes
      const regex = new RegExp(pattern.source, pattern.flags);
      const matches = content.match(regex);
      if (matches) {
        counts[type as keyof Omit<VisualCounts, 'total'>] += matches.length;
      }
    }
  }

  // Mermaid code blocks (```mermaid) also count
  const mermaidBlocks = content.match(MERMAID_CODE_BLOCK_PATTERN);
  if (mermaidBlocks) {
    counts.mermaid += mermaidBlocks.length;
  }

  // Markdown tables (| --- | separator rows)
  const tableSeparators = content.match(MARKDOWN_TABLE_PATTERN);
  if (tableSeparators) {
    counts['markdown-table'] = tableSeparators.length;
  }

  counts.total = Object.entries(counts)
    .filter(([k]) => k !== 'total')
    .reduce((sum, [, v]) => sum + v, 0);

  return counts;
}

// ============================================================================
// Legacy compatibility — drop-in replacements for metrics-extractor
// ============================================================================

/**
 * Count all diagram-type visuals (mermaid + squiggle + cause-effect).
 * Drop-in replacement for the old countDiagrams() in metrics-extractor.
 */
export function countDiagrams(content: string): number {
  const counts = countVisuals(content);
  return counts.mermaid + counts.squiggle + counts['cause-effect'];
}

/**
 * Count all table-type visuals (markdown-table + comparison + table-view).
 * Drop-in replacement for the old countTables() in metrics-extractor.
 */
export function countTables(content: string): number {
  const counts = countVisuals(content);
  return counts['markdown-table'] + counts.comparison + counts['table-view'];
}

// ============================================================================
// Visual extraction (for review/improve pipelines)
// ============================================================================

export interface ExtractedVisual {
  type: string;
  /** The inner code (Mermaid chart code, Squiggle model code, etc.) */
  code: string;
  /** The full raw JSX/markdown match */
  raw: string;
  /** Line number in the source content */
  line: number;
  /** Start offset in the content string */
  startOffset: number;
  /** End offset in the content string */
  endOffset: number;
}

/**
 * Extract all visual elements from MDX content with their positions.
 * Used by visual-review and visual-improve to analyze/replace specific visuals.
 */
export function extractVisuals(content: string): ExtractedVisual[] {
  const visuals: ExtractedVisual[] = [];
  let match: RegExpExecArray | null;

  // Mermaid: <MermaidDiagram chart={`...`} /> or <Mermaid chart={`...`} />
  const mermaidRegex =
    /<(?:MermaidDiagram|Mermaid)[^>]*chart=\{`([\s\S]*?)`\}[^>]*\/?>/g;
  while ((match = mermaidRegex.exec(content)) !== null) {
    visuals.push({
      type: 'mermaid',
      code: match[1],
      raw: match[0],
      line: getLineNumber(content, match.index),
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  // Squiggle: <SquiggleEstimate code={`...`} />
  const squiggleRegex =
    /<SquiggleEstimate[^>]*code=\{`([\s\S]*?)`\}[^>]*\/?>/g;
  while ((match = squiggleRegex.exec(content)) !== null) {
    visuals.push({
      type: 'squiggle',
      code: match[1],
      raw: match[0],
      line: getLineNumber(content, match.index),
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  // CauseEffectGraph and PageCauseEffectGraph (detect presence)
  const cegRegex = /<(?:CauseEffectGraph|PageCauseEffectGraph)[^>]*>/g;
  while ((match = cegRegex.exec(content)) !== null) {
    visuals.push({
      type: 'cause-effect',
      code: match[0],
      raw: match[0],
      line: getLineNumber(content, match.index),
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  // ComparisonTable
  const ctRegex = /<ComparisonTable[\s\S]*?\/>/g;
  while ((match = ctRegex.exec(content)) !== null) {
    visuals.push({
      type: 'comparison',
      code: match[0],
      raw: match[0],
      line: getLineNumber(content, match.index),
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  // DisagreementMap
  const dmRegex = /<DisagreementMap[\s\S]*?\/>/g;
  while ((match = dmRegex.exec(content)) !== null) {
    visuals.push({
      type: 'disagreement',
      code: match[0],
      raw: match[0],
      line: getLineNumber(content, match.index),
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    });
  }

  return visuals;
}
