#!/usr/bin/env node

/**
 * MDX Syntax Validation Script
 *
 * Checks for common MDX/Mermaid syntax errors that cause build failures:
 * - Mermaid code blocks instead of <Mermaid> component
 * - Unescaped < characters followed by numbers (parsed as JSX)
 * - <br/> tags in Mermaid diagrams (not supported)
 * - Subgraph syntax without IDs
 * - sequenceDiagram (rendering issues)
 *
 * Also checks for diagram style issues (info level):
 * - Wide horizontal diagrams (flowchart LR with many nodes)
 * - Very tall diagrams (3+ subgraphs or 15+ nodes)
 *
 * Usage: node scripts/validate-mdx-syntax.mjs [--ci]
 */

import { readFileSync } from 'fs';
import { findMdxFiles } from '../lib/file-utils.mjs';
import { getColors, formatPath } from '../lib/output.mjs';
import { CONTENT_DIR } from '../lib/content-types.js';
import { parseFrontmatter, shouldSkipValidation } from '../lib/mdx-utils.mjs';

const CI_MODE = process.argv.includes('--ci');
const colors = getColors(CI_MODE);

// Patterns to check with descriptions
const PATTERNS = [
  {
    id: 'mermaid-codeblock',
    pattern: /^```mermaid/m,
    description: 'Mermaid code block instead of <Mermaid> component',
    severity: 'error',
    fix: 'Use <Mermaid client:load chart={`...`} /> component instead',
  },
  {
    id: 'unescaped-lt-number',
    pattern: /\| <[0-9]/,
    description: 'Unescaped < followed by number in table (MDX parses as JSX)',
    severity: 'error',
    fix: 'Replace <N with "Less than N" or use &lt;',
  },
  {
    id: 'prose-lt-number',
    pattern: /[^|`$]\s<[0-9]/,
    description: 'Unescaped < followed by number in prose',
    severity: 'warning',
    fix: 'Replace <N with "less than N" or wrap in backticks',
  },
  {
    id: 'subgraph-no-id',
    pattern: /subgraph\s+"[^"]+"\s*\n/,
    description: 'Subgraph without ID (use subgraph ID["Label"] format)',
    severity: 'warning',
    fix: 'Change to: subgraph MyId["My Label"]',
  },
];

// Move sequence diagram check to complex checks to avoid false positives in docs
const SEQUENCE_DIAGRAM_CHECK = {
  id: 'sequence-diagram',
  description: 'sequenceDiagram has rendering issues in some environments',
  severity: 'warning',
  fix: 'Replace with a table + simple flowchart (see style-guides/mermaid-diagrams)',
  check: (content) => {
    const issues = [];
    // Only flag sequenceDiagram inside actual Mermaid components
    const mermaidRegex = /<Mermaid[^>]*chart=\{`([^`]+)`\}/gs;
    let match;
    while ((match = mermaidRegex.exec(content)) !== null) {
      const chart = match[1];
      if (/sequenceDiagram/i.test(chart)) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        issues.push({
          line: lineNum,
          lineContent: 'sequenceDiagram in Mermaid component',
        });
      }
    }
    return issues;
  },
};

// Complex patterns that require multi-line analysis
const COMPLEX_CHECKS = [
  SEQUENCE_DIAGRAM_CHECK,
  {
    id: 'wide-horizontal-diagram',
    description: 'Horizontal flowchart (LR) may render poorly in narrow viewports',
    severity: 'info',
    fix: 'Consider using flowchart TD (vertical) or a table for complex data',
    check: (content) => {
      const issues = [];
      // Find all Mermaid components
      const mermaidRegex = /<Mermaid[^>]*chart=\{`([^`]+)`\}/gs;
      let match;
      while ((match = mermaidRegex.exec(content)) !== null) {
        const chart = match[1];
        // Check if it's a horizontal flowchart
        if (/flowchart\s+LR/i.test(chart)) {
          // Count nodes (rough heuristic: count brackets)
          const nodeCount = (chart.match(/\[[^\]]+\]/g) || []).length;
          if (nodeCount > 8) {
            const lineNum = content.substring(0, match.index).split('\n').length;
            issues.push({
              line: lineNum,
              lineContent: `flowchart LR with ~${nodeCount} nodes`,
            });
          }
        }
      }
      return issues;
    },
  },
  {
    id: 'tall-diagram',
    description: 'Very tall diagram (3+ subgraphs or 15+ nodes) may overwhelm the page',
    severity: 'info',
    fix: 'Consider using a table for details + small summary diagram',
    check: (content) => {
      const issues = [];
      const mermaidRegex = /<Mermaid[^>]*chart=\{`([^`]+)`\}/gs;
      let match;
      while ((match = mermaidRegex.exec(content)) !== null) {
        const chart = match[1];
        const subgraphCount = (chart.match(/subgraph/gi) || []).length;
        const nodeCount = (chart.match(/\[[^\]]+\]/g) || []).length;

        if (subgraphCount >= 3 || nodeCount > 15) {
          const lineNum = content.substring(0, match.index).split('\n').length;
          issues.push({
            line: lineNum,
            lineContent: `${subgraphCount} subgraphs, ~${nodeCount} nodes`,
          });
        }
      }
      return issues;
    },
  },
];

function checkFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const issues = [];

  // Simple pattern checks
  for (const check of PATTERNS) {
    const matches = content.match(new RegExp(check.pattern, 'gm'));
    if (matches) {
      // Find line numbers
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (check.pattern.test(lines[i])) {
          issues.push({
            ...check,
            line: i + 1,
            lineContent: lines[i].substring(0, 80) + (lines[i].length > 80 ? '...' : ''),
          });
        }
      }
    }
  }

  // Complex multi-line checks
  for (const check of COMPLEX_CHECKS) {
    const found = check.check(content);
    for (const issue of found) {
      issues.push({
        id: check.id,
        description: check.description,
        severity: check.severity,
        fix: check.fix,
        line: issue.line,
        lineContent: issue.lineContent,
      });
    }
  }

  return issues;
}

function main() {
  const allFiles = findMdxFiles(CONTENT_DIR);
  // Exclude files starting with _ (meta/documentation files like _STYLE_GUIDE.md)
  const files = allFiles.filter(f => {
    const basename = f.split('/').pop();
    return !basename.startsWith('_');
  });
  const allIssues = [];
  let errorCount = 0;
  let warningCount = 0;

  if (!CI_MODE) {
    console.log(`${colors.blue}Checking ${files.length} MDX files for syntax issues...${colors.reset}\n`);
    if (allFiles.length !== files.length) {
      console.log(`${colors.dim}(Excluding ${allFiles.length - files.length} meta files starting with _)${colors.reset}\n`);
    }
  }

  let infoCount = 0;
  let skippedCount = 0;
  for (const file of files) {
    // Skip documentation pages that may contain examples triggering false positives
    const content = readFileSync(file, 'utf-8');
    const frontmatter = parseFrontmatter(content);
    if (shouldSkipValidation(frontmatter)) {
      skippedCount++;
      continue;
    }

    const issues = checkFile(file);
    if (issues.length > 0) {
      allIssues.push({ file, issues });
      for (const issue of issues) {
        if (issue.severity === 'error') errorCount++;
        else if (issue.severity === 'warning') warningCount++;
        else infoCount++;
      }
    }
  }

  if (CI_MODE) {
    console.log(JSON.stringify({
      files: files.length,
      errors: errorCount,
      warnings: warningCount,
      infos: infoCount,
      issues: allIssues,
    }, null, 2));
  } else {
    if (allIssues.length === 0) {
      console.log(`${colors.green}✓ No syntax issues found${colors.reset}\n`);
    } else {
      for (const { file, issues } of allIssues) {
        const relPath = file.replace(process.cwd() + '/', '');
        console.log(`${colors.bold}${relPath}${colors.reset}`);

        for (const issue of issues) {
          let icon;
          if (issue.severity === 'error') icon = `${colors.red}✗`;
          else if (issue.severity === 'warning') icon = `${colors.yellow}⚠`;
          else icon = `${colors.blue}ℹ`;
          console.log(`  ${icon} Line ${issue.line}: ${issue.description}${colors.reset}`);
          console.log(`    ${colors.dim}${issue.lineContent}${colors.reset}`);
          console.log(`    ${colors.blue}Fix: ${issue.fix}${colors.reset}`);
        }
        console.log();
      }

      console.log(`${colors.bold}Summary:${colors.reset}`);
      if (errorCount > 0) {
        console.log(`  ${colors.red}${errorCount} error(s)${colors.reset}`);
      }
      if (warningCount > 0) {
        console.log(`  ${colors.yellow}${warningCount} warning(s)${colors.reset}`);
      }
      if (infoCount > 0) {
        console.log(`  ${colors.blue}${infoCount} info(s) - diagram style suggestions${colors.reset}`);
      }
      console.log();
    }
  }

  // Exit with error code if there are errors
  process.exit(errorCount > 0 ? 1 : 0);
}

main();
