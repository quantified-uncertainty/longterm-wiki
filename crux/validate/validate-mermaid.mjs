#!/usr/bin/env node

/**
 * Mermaid Diagram Validation Script
 *
 * Two-pronged approach:
 * 1. Static syntax analysis - checks for common syntax errors without rendering
 * 2. Mermaid CLI validation - uses @mermaid-js/mermaid-cli to actually render and validate
 *
 * Usage:
 *   node scripts/validate-mermaid.mjs              # Static analysis only
 *   node scripts/validate-mermaid.mjs --render     # Also validate with mermaid-cli (requires install)
 *   node scripts/validate-mermaid.mjs --ci         # CI mode (JSON output)
 *   node scripts/validate-mermaid.mjs --fix        # Show detailed fix suggestions
 *
 * To enable render validation:
 *   npm install -g @mermaid-js/mermaid-cli
 *   # or
 *   npx mmdc --help  (to use via npx)
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors, isCI } from '../lib/output.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = join(__dirname, '../..', 'content/docs');
const TEMP_DIR = join(__dirname, '../..', '.mermaid-validate-temp');

const RENDER_MODE = process.argv.includes('--render');
const FIX_MODE = process.argv.includes('--fix');

const colors = getColors();

// ============================================================================
// STATIC ANALYSIS CHECKS
// ============================================================================

const STATIC_CHECKS = [
  {
    id: 'unclosed-bracket',
    description: 'Unclosed square bracket in node definition',
    severity: 'error',
    check: (chart) => {
      const issues = [];
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
    check: (chart) => {
      const issues = [];
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
    check: (chart) => {
      const issues = [];
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
    check: (chart) => {
      const issues = [];
      const lines = chart.split('\n');

      // Common invalid arrow patterns - must be careful not to match valid arrows
      const invalidPatterns = [
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
    check: (chart) => {
      const issues = [];
      const trimmed = chart.trim();

      const validTypes = [
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
    check: (chart) => {
      const issues = [];
      const lines = chart.split('\n');

      // Only check flowcharts/graphs
      const firstLine = chart.trim().split('\n')[0].toLowerCase();
      if (!firstLine.startsWith('flowchart') && !firstLine.startsWith('graph')) {
        return issues;
      }

      // Extract defined nodes
      const definedNodes = new Set();
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
        let arrowMatch;
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
    check: (chart) => {
      const issues = [];
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
    check: (chart) => {
      const issues = [];
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
    check: (chart) => {
      const issues = [];
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
    check: (chart) => {
      const issues = [];
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
    check: (chart) => {
      const issues = [];
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

function extractMermaidCharts(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const charts = [];

  // Match <Mermaid client:load chart={`...`} />
  const mermaidRegex = /<Mermaid[^>]*chart=\{`([\s\S]*?)`\}[^>]*\/>/g;

  let match;
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
// MERMAID CLI VALIDATION
// ============================================================================

function checkMermaidCli() {
  try {
    execSync('npx mmdc --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function validateWithCli(chart, index) {
  const tempFile = join(TEMP_DIR, `chart-${index}.mmd`);
  const outFile = join(TEMP_DIR, `chart-${index}.svg`);

  writeFileSync(tempFile, chart);

  try {
    const result = spawnSync('npx', ['mmdc', '-i', tempFile, '-o', outFile, '-q'], {
      encoding: 'utf-8',
      timeout: 10000,
    });

    if (result.status !== 0) {
      return {
        valid: false,
        error: result.stderr || result.stdout || 'Unknown rendering error',
      };
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err.message,
    };
  }
}

// ============================================================================
// MAIN VALIDATION
// ============================================================================

function validateChart(chart, filePath, chartLine) {
  const issues = [];

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

function main() {
  const startTime = Date.now();
  const files = findMdxFiles(CONTENT_DIR);

  let totalCharts = 0;
  let errorCount = 0;
  let warningCount = 0;
  const allIssues = [];

  // Check for mermaid CLI if render mode requested
  const hasCli = RENDER_MODE && checkMermaidCli();

  if (RENDER_MODE && !hasCli) {
    if (!isCI()) {
      console.log(`${colors.yellow}⚠ Mermaid CLI not found. Install with: npm install -g @mermaid-js/mermaid-cli${colors.reset}\n`);
      console.log(`${colors.dim}Falling back to static analysis only${colors.reset}\n`);
    }
  }

  if (RENDER_MODE && hasCli) {
    mkdirSync(TEMP_DIR, { recursive: true });
  }

  if (!isCI()) {
    console.log(`${colors.blue}Validating Mermaid diagrams in ${files.length} files...${colors.reset}\n`);
  }

  let chartIndex = 0;

  for (const file of files) {
    const charts = extractMermaidCharts(file);
    if (charts.length === 0) continue;

    totalCharts += charts.length;
    const fileIssues = [];

    for (const chart of charts) {
      // Static analysis
      const staticIssues = validateChart(chart, file, chart.line);
      fileIssues.push(...staticIssues);

      // CLI validation if available
      if (RENDER_MODE && hasCli) {
        const cliResult = validateWithCli(chart.content, chartIndex++);
        if (!cliResult.valid) {
          fileIssues.push({
            id: 'render-error',
            description: 'Mermaid rendering failed',
            severity: 'error',
            fix: 'Check the Mermaid syntax - the diagram cannot be rendered',
            line: chart.line,
            message: cliResult.error,
            context: chart.content.split('\n')[0],
          });
        }
      }
    }

    if (fileIssues.length > 0) {
      allIssues.push({ file, issues: fileIssues, chartCount: charts.length });
      for (const issue of fileIssues) {
        if (issue.severity === 'error') errorCount++;
        else if (issue.severity === 'warning') warningCount++;
      }
    }
  }

  // Cleanup temp files
  if (RENDER_MODE && hasCli) {
    try {
      rmSync(TEMP_DIR, { recursive: true, force: true });
    } catch {}
  }

  const duration = Date.now() - startTime;

  // Output results
  if (isCI()) {
    console.log(JSON.stringify({
      files: files.length,
      charts: totalCharts,
      errors: errorCount,
      warnings: warningCount,
      issues: allIssues,
      duration,
      renderMode: RENDER_MODE && hasCli,
    }, null, 2));
  } else {
    if (allIssues.length === 0) {
      console.log(`${colors.green}✓ All ${totalCharts} Mermaid diagrams passed validation${colors.reset}`);
      console.log(`${colors.dim}  Checked ${files.length} files in ${duration}ms${colors.reset}\n`);
    } else {
      for (const { file, issues, chartCount } of allIssues) {
        const relPath = file.replace(process.cwd() + '/', '');
        console.log(`${colors.bold}${relPath}${colors.reset} ${colors.dim}(${chartCount} diagram${chartCount > 1 ? 's' : ''})${colors.reset}`);

        for (const issue of issues) {
          const icon = issue.severity === 'error'
            ? `${colors.red}✗`
            : `${colors.yellow}⚠`;

          console.log(`  ${icon} Line ${issue.line}: ${issue.message}${colors.reset}`);
          console.log(`    ${colors.dim}${issue.context.substring(0, 70)}${issue.context.length > 70 ? '...' : ''}${colors.reset}`);

          if (FIX_MODE) {
            console.log(`    ${colors.cyan}Fix: ${issue.fix}${colors.reset}`);
          }
        }
        console.log();
      }

      console.log(`${colors.bold}Summary:${colors.reset}`);
      console.log(`  ${colors.dim}Charts scanned: ${totalCharts}${colors.reset}`);
      if (errorCount > 0) {
        console.log(`  ${colors.red}${errorCount} error(s)${colors.reset}`);
      }
      if (warningCount > 0) {
        console.log(`  ${colors.yellow}${warningCount} warning(s)${colors.reset}`);
      }
      console.log(`  ${colors.dim}Duration: ${duration}ms${colors.reset}`);

      if (!FIX_MODE && (errorCount > 0 || warningCount > 0)) {
        console.log(`\n${colors.dim}Run with --fix for detailed fix suggestions${colors.reset}`);
      }
      console.log();
    }
  }

  process.exit(errorCount > 0 ? 1 : 0);
}

main();
