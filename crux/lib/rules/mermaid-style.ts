/**
 * Mermaid Diagram Style Compliance Rule
 *
 * Validates that Mermaid diagrams in MDX files comply with the project's
 * style guide (content/docs/internal/mermaid-diagrams.mdx):
 *
 * - Max 15-20 nodes per diagram
 * - Max 3-4 parallel nodes per subgraph level
 * - Must use `flowchart TD` orientation (not LR, BT, etc.)
 *
 * This rule uses static analysis on the chart text, not rendering.
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';

const MAX_TOTAL_NODES = 20;
const MAX_PARALLEL_NODES = 4;

// Extract Mermaid chart content from <Mermaid chart={`...`} /> components
const MERMAID_COMPONENT_PATTERN = /<Mermaid[^>]*chart=\{`([\s\S]*?)`\}[^>]*\/>/g;

// Node definition patterns in Mermaid flowcharts
// Matches: A[text], A(text), A{text}, A((text)), A>text], A[/text/], etc.
const NODE_DEF_PATTERN = /(?:^|\s)([A-Za-z_][\w]*)[\[({>]/gm;

// Arrow patterns that define edges (and may also define nodes inline)
const ARROW_PATTERN = /-->|-->/g;

// Subgraph block pattern
const SUBGRAPH_PATTERN = /^\s*subgraph\s+(\w+)/;
const END_PATTERN = /^\s*end\s*$/;

interface SubgraphInfo {
  name: string;
  directChildren: Set<string>;
  line: number;
}

/**
 * Count unique node IDs in a Mermaid chart, excluding keywords.
 */
function countNodes(chart: string): string[] {
  const keywords = new Set([
    'subgraph', 'end', 'flowchart', 'graph', 'direction',
    'TD', 'TB', 'LR', 'RL', 'BT',
    'style', 'classDef', 'class', 'click', 'linkStyle',
  ]);

  const nodes = new Set<string>();
  const lines = chart.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments, empty lines, direction declarations, and subgraph/end lines
    if (!trimmed || trimmed.startsWith('%%') || SUBGRAPH_PATTERN.test(trimmed) || END_PATTERN.test(trimmed)) continue;
    if (/^\s*(flowchart|graph)\s/.test(trimmed)) continue;
    if (/^\s*direction\s/.test(trimmed)) continue;
    if (/^\s*(style|classDef|class|click|linkStyle)\s/.test(trimmed)) continue;

    // Extract node IDs from definitions and edge declarations
    const nodeRegex = new RegExp(NODE_DEF_PATTERN.source, 'gm');
    let match: RegExpExecArray | null;
    while ((match = nodeRegex.exec(trimmed)) !== null) {
      const id = match[1];
      if (!keywords.has(id)) {
        nodes.add(id);
      }
    }
  }

  return Array.from(nodes);
}

/**
 * Analyze subgraph structure and count direct children per subgraph.
 */
function analyzeSubgraphs(chart: string): SubgraphInfo[] {
  const subgraphs: SubgraphInfo[] = [];
  const lines = chart.split('\n');
  const keywords = new Set([
    'subgraph', 'end', 'flowchart', 'graph', 'direction',
    'TD', 'TB', 'LR', 'RL', 'BT',
    'style', 'classDef', 'class', 'click', 'linkStyle',
  ]);

  let currentSubgraph: SubgraphInfo | null = null;
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (SUBGRAPH_PATTERN.test(trimmed)) {
      const match = trimmed.match(SUBGRAPH_PATTERN);
      if (match) {
        if (depth === 0 || currentSubgraph) {
          // Save previous subgraph if at same level
          if (currentSubgraph && depth === 1) {
            subgraphs.push(currentSubgraph);
          }
        }
        currentSubgraph = {
          name: match[1],
          directChildren: new Set(),
          line: i + 1,
        };
        depth++;
        continue;
      }
    }

    if (END_PATTERN.test(trimmed)) {
      if (currentSubgraph && depth > 0) {
        subgraphs.push(currentSubgraph);
        currentSubgraph = null;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }

    // If inside a subgraph, collect direct node children (not nested subgraphs)
    if (currentSubgraph && depth > 0) {
      // Skip non-node lines
      if (!trimmed || trimmed.startsWith('%%') || /^\s*direction\s/.test(trimmed)) continue;
      if (/^\s*(style|classDef|class|click|linkStyle)\s/.test(trimmed)) continue;

      // Only count node definitions (not edge-only lines)
      const nodeRegex = new RegExp(NODE_DEF_PATTERN.source, 'gm');
      let match: RegExpExecArray | null;
      while ((match = nodeRegex.exec(trimmed)) !== null) {
        const id = match[1];
        if (!keywords.has(id)) {
          currentSubgraph.directChildren.add(id);
        }
      }
    }
  }

  return subgraphs;
}

/**
 * Check chart orientation.
 */
function getOrientation(chart: string): string | null {
  const match = chart.match(/^\s*(flowchart|graph)\s+(TD|TB|LR|RL|BT)/m);
  return match ? match[2] : null;
}

export const mermaidStyleRule = {
  id: 'mermaid-style',
  name: 'Mermaid Diagram Style',
  description: 'Validate Mermaid diagrams comply with project style guide (max nodes, parallel nodes, orientation)',

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const content = contentFile.raw || '';
    if (!content) return issues;

    // Extract all Mermaid charts from the file
    const chartRegex = new RegExp(MERMAID_COMPONENT_PATTERN.source, 'gs');
    let chartMatch: RegExpExecArray | null;

    while ((chartMatch = chartRegex.exec(content)) !== null) {
      const chart = chartMatch[1];
      const chartStartLine = content.substring(0, chartMatch.index).split('\n').length;

      // 1. Check orientation
      const orientation = getOrientation(chart);
      if (orientation && orientation !== 'TD' && orientation !== 'TB') {
        issues.push(new Issue({
          rule: 'mermaid-style',
          file: contentFile.path,
          line: chartStartLine,
          message: `Mermaid diagram uses "${orientation}" orientation. Style guide prefers "flowchart TD" (top-down).`,
          severity: Severity.WARNING,
        }));
      }

      // 2. Check total node count
      const nodes = countNodes(chart);
      if (nodes.length > MAX_TOTAL_NODES) {
        issues.push(new Issue({
          rule: 'mermaid-style',
          file: contentFile.path,
          line: chartStartLine,
          message: `Mermaid diagram has ${nodes.length} nodes (max ${MAX_TOTAL_NODES}). Consider splitting into multiple diagrams or using a table.`,
          severity: Severity.WARNING,
        }));
      }

      // 3. Check parallel nodes per subgraph
      const subgraphs = analyzeSubgraphs(chart);
      for (const sg of subgraphs) {
        if (sg.directChildren.size > MAX_PARALLEL_NODES) {
          issues.push(new Issue({
            rule: 'mermaid-style',
            file: contentFile.path,
            line: chartStartLine + sg.line - 1,
            message: `Subgraph "${sg.name}" has ${sg.directChildren.size} parallel nodes (max ${MAX_PARALLEL_NODES}). Split into sub-subgraphs or use a table for taxonomies.`,
            severity: Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
};
