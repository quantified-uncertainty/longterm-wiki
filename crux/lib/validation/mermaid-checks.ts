/**
 * Mermaid Diagram Static Checks
 *
 * Pure, stateless functions that analyze Mermaid chart syntax without
 * rendering. Extracted from `crux/validate/validate-mermaid.ts` so they
 * can be reused (e.g. in authoring pipelines) without pulling in CLI
 * dependencies.
 *
 * This module exports:
 * - `STATIC_CHECKS` — the registry of all static analysis checks
 * - `extractMermaidCharts()` — extracts `<Mermaid>` charts from an MDX file
 * - `validateChart()` — runs every static check against a single chart
 * - Supporting type interfaces (`CheckIssue`, `StaticCheck`, `ChartIssue`, etc.)
 */

import { readFileSync } from 'fs';

// ============================================================================
// TYPES
// ============================================================================

/** A single issue reported by one static check against one chart line. */
export interface CheckIssue {
  line: number;
  message: string;
  context: string;
}

/** Descriptor for a static syntax check. */
export interface StaticCheck {
  id: string;
  description: string;
  severity: 'error' | 'warning';
  /** Run the check against raw chart text; return any issues found. */
  check: (chart: string) => CheckIssue[];
  /** Human-readable fix suggestion. */
  fix: string;
}

/** A pattern that matches an invalid arrow syntax variant. */
export interface InvalidArrowPattern {
  pattern: RegExp;
  message: string;
}

/** A Mermaid chart extracted from an MDX file. */
export interface ExtractedChart {
  content: string;
  line: number;
  raw: string;
}

/**
 * A fully-resolved issue combining the check metadata with the specific
 * line/message/context from a `CheckIssue`.
 */
export interface ChartIssue {
  id: string;
  description: string;
  severity: 'error' | 'warning';
  fix: string;
  line: number;
  message: string;
  context: string;
}

// ============================================================================
// STATIC ANALYSIS CHECKS
// ============================================================================

/**
 * Registry of all static Mermaid syntax checks.
 *
 * Each entry runs a pure function over chart text and returns zero or more
 * `CheckIssue` items. The checks are intentionally conservative — false
 * positives are surfaced as warnings rather than errors.
 */
export const STATIC_CHECKS: StaticCheck[] = [
  {
    id: 'unclosed-bracket',
    description: 'Unclosed square bracket in node definition',
    severity: 'error',
    check: (chart: string): CheckIssue[] => {
      const issues: CheckIssue[] = [];
      // Count brackets, accounting for escaped ones
      let depth = 0;
      let lineNum = 1;
      let lineStart = 0;

      for (let i = 0; i < chart.length; i++) {
        if (chart[i] === '\n') {
          if (depth !== 0) {
            issues.push({
              line: lineNum,
              message: `Unclosed '[' bracket (depth: ${depth})`,
              context: chart.substring(lineStart, i).trim(),
            });
          }
          lineNum++;
          lineStart = i + 1;
          depth = 0; // Reset per line for Mermaid
        } else if (chart[i] === '[' && chart[i-1] !== '\\') {
          depth++;
        } else if (chart[i] === ']' && chart[i-1] !== '\\') {
          depth--;
          if (depth < 0) {
            issues.push({
              line: lineNum,
              message: 'Extra closing "]" bracket',
              context: chart.substring(lineStart, i + 10).trim(),
            });
            depth = 0;
          }
        }
      }
      return issues;
    },
    fix: 'Ensure all [ brackets have matching ] brackets',
  },

  {
    id: 'unclosed-paren',
    description: 'Unclosed parenthesis in node definition',
    severity: 'error',
    check: (chart: string): CheckIssue[] => {
      const issues: CheckIssue[] = [];
      const lines = chart.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments and empty lines
        if (line.trim().startsWith('%%') || !line.trim()) continue;

        let depth = 0;
        for (const char of line) {
          if (char === '(') depth++;
          else if (char === ')') depth--;
        }

        if (depth !== 0) {
          issues.push({
            line: i + 1,
            message: depth > 0 ? `Unclosed '(' parenthesis` : `Extra ')' parenthesis`,
            context: line.trim(),
          });
        }
      }
      return issues;
    },
    fix: 'Ensure all ( have matching ) on the same line',
  },

  {
    id: 'unbalanced-quotes',
    description: 'Unbalanced quotes in diagram',
    severity: 'error',
    check: (chart: string): CheckIssue[] => {
      const issues: CheckIssue[] = [];
      const lines = chart.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('%%')) continue;

        const doubleQuotes = (line.match(/"/g) || []).length;
        if (doubleQuotes % 2 !== 0) {
          issues.push({
            line: i + 1,
            message: 'Unbalanced double quotes',
            context: line.trim(),
          });
        }
      }
      return issues;
    },
    fix: 'Ensure all " quotes are properly paired',
  },

  {
    id: 'invalid-arrow',
    description: 'Invalid arrow syntax',
    severity: 'error',
    check: (chart: string): CheckIssue[] => {
      const issues: CheckIssue[] = [];
      const lines = chart.split('\n');

      // Common invalid arrow patterns - must be careful not to match valid arrows
      const invalidPatterns: InvalidArrowPattern[] = [
        // Single arrow -> should be --> (but not inside |...|, and not if part of ->>)
        { pattern: /\w\s*->(?!>|-)(?!\|)\s*\w/, message: 'Use --> instead of -> for flowchart arrows' },
        // Space in arrow: -- > or < --
        { pattern: /--\s+>/, message: 'No space allowed in arrow: "-- >" should be "-->"' },
        { pattern: /<\s+--/, message: 'No space allowed in arrow: "< --" should be "<--"' },
        // Malformed dotted arrows
        { pattern: /\.-\.(?!->)/, message: 'Dotted arrow should be -.-> not .-.' },
      ];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().startsWith('%%')) continue;

        for (const { pattern, message } of invalidPatterns) {
          if (pattern.test(line)) {
            issues.push({
              line: i + 1,
              message,
              context: line.trim(),
            });
          }
        }
      }
      return issues;
    },
    fix: 'Use proper arrow syntax: -->, <--, -.->',
  },

  {
    id: 'missing-diagram-type',
    description: 'Missing or invalid diagram type declaration',
    severity: 'error',
    check: (chart: string): CheckIssue[] => {
      const issues: CheckIssue[] = [];
      const trimmed = chart.trim();

      const validTypes: string[] = [
        'flowchart', 'graph', 'sequenceDiagram', 'classDiagram',
        'stateDiagram', 'stateDiagram-v2', 'erDiagram', 'journey',
        'gantt', 'pie', 'quadrantChart', 'requirementDiagram',
        'gitGraph', 'mindmap', 'timeline', 'sankey', 'xychart-beta',
        'block-beta', 'packet-beta', 'architecture-beta', 'kanban'
      ];

      const firstLine = trimmed.split('\n')[0].trim().toLowerCase();
      const hasValidType = validTypes.some(type =>
        firstLine.startsWith(type.toLowerCase()) ||
        firstLine.startsWith('%%') // Allow directives first
      );

      // Check second line if first is a directive
      if (firstLine.startsWith('%%')) {
        const lines = trimmed.split('\n');
        let foundType = false;
        for (let i = 1; i < Math.min(5, lines.length); i++) {
          const line = lines[i].trim().toLowerCase();
          if (validTypes.some(type => line.startsWith(type.toLowerCase()))) {
            foundType = true;
            break;
          }
        }
        if (!foundType) {
          issues.push({
            line: 1,
            message: 'No valid diagram type found after directives',
            context: trimmed.split('\n').slice(0, 3).join(' | '),
          });
        }
      } else if (!hasValidType) {
        issues.push({
          line: 1,
          message: `Invalid or missing diagram type: "${firstLine.substring(0, 30)}"`,
          context: firstLine,
        });
      }

      return issues;
    },
    fix: 'Start diagram with valid type: flowchart TD, pie, quadrantChart, etc.',
  },

  {
    id: 'undefined-node-reference',
    description: 'Arrow references undefined node',
    severity: 'warning',
    check: (chart: string): CheckIssue[] => {
      const issues: CheckIssue[] = [];
      const lines = chart.split('\n');

      // Only check flowcharts/graphs
      const firstLine = chart.trim().split('\n')[0].toLowerCase();
      if (!firstLine.startsWith('flowchart') && !firstLine.startsWith('graph')) {
        return issues;
      }

      // Extract defined nodes
      const definedNodes = new Set<string>();
      const nodeDefPattern = /^\s*(\w+)[\[\(\{<]/;
      const nodeRefPattern = /(\w+)\s*(?:-->|---|\.-\.->|==>|--)/g;
      const arrowTargetPattern = /(?:-->|---|\.-\.->|==>|--)\s*(?:\|[^|]*\|)?\s*(\w+)/g;

      // First pass: find all defined nodes
      for (const line of lines) {
        if (line.trim().startsWith('%%') || line.trim().startsWith('subgraph')) continue;

        const match = line.match(nodeDefPattern);
        if (match) {
          definedNodes.add(match[1]);
        }

        // Also add nodes that appear on either side of arrows (implicit definition)
        let arrowMatch: RegExpExecArray | null;
        while ((arrowMatch = nodeRefPattern.exec(line)) !== null) {
          definedNodes.add(arrowMatch[1]);
        }
        nodeRefPattern.lastIndex = 0;

        while ((arrowMatch = arrowTargetPattern.exec(line)) !== null) {
          definedNodes.add(arrowMatch[1]);
        }
        arrowTargetPattern.lastIndex = 0;
      }

      // Add common built-in nodes
      ['end', 'start', 'END', 'START'].forEach(n => definedNodes.add(n));

      return issues;
    },
    fix: 'Define nodes before referencing them in arrows',
  },

  {
    id: 'subgraph-syntax',
    description: 'Invalid subgraph syntax',
    severity: 'warning',
    check: (chart: string): CheckIssue[] => {
      const issues: CheckIssue[] = [];
      const lines = chart.split('\n');

      let subgraphDepth = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('subgraph')) {
          subgraphDepth++;

          // Check for proper syntax: subgraph ID["Label"] or subgraph ID
          const subgraphPattern = /^subgraph\s+(\w+)(?:\s*\["[^"]*"\])?$/;
          const oldSyntax = /^subgraph\s+"[^"]+"\s*$/;

          if (oldSyntax.test(line)) {
            issues.push({
              line: i + 1,
              message: 'Subgraph missing ID (use: subgraph ID["Label"])',
              context: line,
            });
          }
        } else if (line === 'end') {
          subgraphDepth--;
          if (subgraphDepth < 0) {
            issues.push({
              line: i + 1,
              message: 'Extra "end" without matching subgraph',
              context: line,
            });
            subgraphDepth = 0;
          }
        }
      }

      if (subgraphDepth > 0) {
        issues.push({
          line: lines.length,
          message: `Missing ${subgraphDepth} "end" statement(s) for subgraph(s)`,
          context: 'End of diagram',
        });
      }

      return issues;
    },
    fix: 'Use subgraph ID["Label"] syntax and ensure each subgraph has matching "end"',
  },

  {
    id: 'style-syntax',
    description: 'Invalid style statement syntax',
    severity: 'warning',
    check: (chart: string): CheckIssue[] => {
      const issues: CheckIssue[] = [];
      const lines = chart.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('style ')) {
          // Valid: style NodeId fill:#fff,stroke:#333
          const stylePattern = /^style\s+\w+\s+\w+:.+$/;
          if (!stylePattern.test(line)) {
            issues.push({
              line: i + 1,
              message: 'Invalid style syntax',
              context: line,
            });
          }
        }

        if (line.startsWith('classDef ')) {
          // Valid: classDef className fill:#fff,stroke:#333
          const classDefPattern = /^classDef\s+\w+\s+\w+:.+$/;
          if (!classDefPattern.test(line)) {
            issues.push({
              line: i + 1,
              message: 'Invalid classDef syntax',
              context: line,
            });
          }
        }
      }

      return issues;
    },
    fix: 'Use: style NodeId fill:#color,stroke:#color',
  },

  {
    id: 'pie-chart-syntax',
    description: 'Invalid pie chart syntax',
    severity: 'error',
    check: (chart: string): CheckIssue[] => {
      const issues: CheckIssue[] = [];
      const trimmed = chart.trim();

      if (!trimmed.toLowerCase().startsWith('pie')) return issues;

      const lines = trimmed.split('\n');

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('%%') || line.startsWith('title')) continue;

        // Valid: "Label" : 42 or "Label": 42.5
        const piePattern = /^\s*"[^"]+"\s*:\s*[\d.]+\s*$/;
        if (!piePattern.test(line)) {
          issues.push({
            line: i + 1,
            message: 'Invalid pie chart entry',
            context: line,
          });
        }
      }

      return issues;
    },
    fix: 'Use: "Label" : 42 (quoted label, colon, number)',
  },

  {
    id: 'quadrant-syntax',
    description: 'Invalid quadrant chart syntax',
    severity: 'error',
    check: (chart: string): CheckIssue[] => {
      const issues: CheckIssue[] = [];
      const trimmed = chart.trim();

      if (!trimmed.toLowerCase().startsWith('quadrantchart')) return issues;

      const lines = trimmed.split('\n');
      let hasXAxis = false;
      let hasYAxis = false;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('%%')) continue;

        if (line.startsWith('x-axis')) hasXAxis = true;
        if (line.startsWith('y-axis')) hasYAxis = true;

        // Check point syntax: "Label": [0.5, 0.5] or Label: [0.5, 0.5]
        if (line.includes(':') && line.includes('[')) {
          const pointPattern = /^.+:\s*\[\s*[\d.]+\s*,\s*[\d.]+\s*\]\s*$/;
          if (!pointPattern.test(line)) {
            issues.push({
              line: i + 1,
              message: 'Invalid quadrant point syntax',
              context: line,
            });
          }
        }
      }

      if (!hasXAxis) {
        issues.push({ line: 1, message: 'Missing x-axis definition', context: 'quadrantChart' });
      }
      if (!hasYAxis) {
        issues.push({ line: 1, message: 'Missing y-axis definition', context: 'quadrantChart' });
      }

      return issues;
    },
    fix: 'QuadrantChart needs: x-axis, y-axis, and points as "Label": [x, y]',
  },

  {
    id: 'special-chars-in-labels',
    description: 'Problematic special characters in labels',
    severity: 'warning',
    check: (chart: string): CheckIssue[] => {
      const issues: CheckIssue[] = [];
      const lines = chart.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for problematic < or > inside brackets
        // Exclude <br/>, <br>, and other valid HTML-like tags
        const bracketContent = line.match(/\[([^\]]+)\]/g);
        if (bracketContent) {
          for (const bracket of bracketContent) {
            // Remove known safe patterns before checking
            const cleaned = bracket
              .replace(/<br\s*\/?>/gi, '') // <br>, <br/>, <br />
              .replace(/<\/?[a-z]+>/gi, ''); // Other HTML-like tags

            // Now check for remaining problematic < or >
            if (/<(?![a-z])/i.test(cleaned) || /(?<![a-z\/])>/i.test(cleaned)) {
              // Only flag if it looks like a comparison operator or unmatched bracket
              if (/[<>]\s*\d/.test(cleaned) || /\d\s*[<>]/.test(cleaned)) {
                issues.push({
                  line: i + 1,
                  message: 'Comparison operator in label may cause rendering issues',
                  context: bracket,
                });
              }
            }
          }
        }

        // Skip curly brace check for diagram types that use them legitimately
        // (erDiagram, classDiagram use { } for relationships and class bodies)
      }

      return issues;
    },
    fix: 'Quote labels with special characters or use words: "less than 5" instead of "<5"',
  },
];

// ============================================================================
// CHART EXTRACTION
// ============================================================================

/**
 * Extract all `<Mermaid ... chart={\`...\`} />` blocks from an MDX file.
 *
 * @param filePath - Absolute path to the MDX file to scan.
 * @returns An array of extracted charts with their content, source line, and raw match text.
 */
export function extractMermaidCharts(filePath: string): ExtractedChart[] {
  const content = readFileSync(filePath, 'utf-8');
  const charts: ExtractedChart[] = [];

  // Match <Mermaid client:load chart={`...`} />
  const mermaidRegex = /<Mermaid[^>]*chart=\{`([\s\S]*?)`\}[^>]*\/>/g;

  let match: RegExpExecArray | null;
  while ((match = mermaidRegex.exec(content)) !== null) {
    const chart = match[1];
    const lineNum = content.substring(0, match.index).split('\n').length;
    charts.push({
      content: chart,
      line: lineNum,
      raw: match[0],
    });
  }

  return charts;
}

// ============================================================================
// CHART VALIDATION
// ============================================================================

/**
 * Run every static check in `STATIC_CHECKS` against a single extracted chart.
 *
 * @param chart - The extracted chart to validate.
 * @param _filePath - Path of the source file (currently unused, reserved for future diagnostics).
 * @param chartLine - The line number in the source file where the chart starts.
 * @returns An array of `ChartIssue` items combining check metadata with per-line findings.
 */
export function validateChart(chart: ExtractedChart, _filePath: string, chartLine: number): ChartIssue[] {
  const issues: ChartIssue[] = [];

  // Run all static checks
  for (const check of STATIC_CHECKS) {
    try {
      const checkIssues = check.check(chart.content);
      for (const issue of checkIssues) {
        issues.push({
          id: check.id,
          description: check.description,
          severity: check.severity,
          fix: check.fix,
          line: chartLine + issue.line - 1,
          message: issue.message,
          context: issue.context,
        });
      }
    } catch (err) {
      // Check failed, skip
    }
  }

  return issues;
}
