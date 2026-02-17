#!/usr/bin/env node

/**
 * Mermaid Diagram Validation Script
 *
 * Two-pronged approach:
 * 1. Static syntax analysis - checks for common syntax errors without rendering
 * 2. Mermaid CLI validation - uses @mermaid-js/mermaid-cli to actually render and validate
 *
 * Static check implementations live in `crux/lib/mermaid-checks.ts`.
 * This file handles CLI orchestration, rendering validation, and output formatting.
 *
 * Usage:
 *   npx tsx crux/validate/validate-mermaid.ts              # Static analysis only
 *   npx tsx crux/validate/validate-mermaid.ts --render     # Also validate with mermaid-cli (requires install)
 *   npx tsx crux/validate/validate-mermaid.ts --ci         # CI mode (JSON output)
 *   npx tsx crux/validate/validate-mermaid.ts --fix        # Show detailed fix suggestions
 *
 * To enable render validation:
 *   npm install -g @mermaid-js/mermaid-cli
 *   # or
 *   npx mmdc --help  (to use via npx)
 */

import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { spawnSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors, isCI } from '../lib/output.ts';
import { CONTENT_DIR_ABS as CONTENT_DIR, PROJECT_ROOT } from '../lib/content-types.ts';
import {
  extractMermaidCharts,
  validateChart,
  type ChartIssue,
} from '../lib/mermaid-checks.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';

const TEMP_DIR = join(PROJECT_ROOT, '.mermaid-validate-temp');

// ============================================================================
// TYPES (CLI-specific)
// ============================================================================

interface CliValidationResult {
  valid: boolean;
  error?: string;
}

interface FileIssueGroup {
  file: string;
  issues: ChartIssue[];
  chartCount: number;
}

interface CIOutput {
  files: number;
  charts: number;
  errors: number;
  warnings: number;
  issues: FileIssueGroup[];
  duration: number;
  renderMode: boolean;
}

// ============================================================================
// MERMAID CLI VALIDATION
// ============================================================================

/** Check whether the Mermaid CLI (`mmdc`) is available on this system. */
function checkMermaidCli(): boolean {
  try {
    execSync('npx mmdc --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Render a single chart via the Mermaid CLI and report success/failure. */
function validateWithCli(chart: string, index: number): CliValidationResult {
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
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      valid: false,
      error: error.message,
    };
  }
}

// ============================================================================
// MAIN VALIDATION
// ============================================================================

/**
 * Run the Mermaid validation check and return a ValidatorResult.
 * Can be called in-process by the orchestrator.
 */
export function runCheck(options: ValidatorOptions = {}): ValidatorResult {
  const files = findMdxFiles(CONTENT_DIR);
  let errorCount = 0;
  let warningCount = 0;

  for (const file of files) {
    const charts = extractMermaidCharts(file);
    if (charts.length === 0) continue;

    for (const chart of charts) {
      const issues = validateChart(chart, file, chart.line);
      for (const issue of issues) {
        if (issue.severity === 'error') errorCount++;
        else if (issue.severity === 'warning') warningCount++;
      }
    }
  }

  return {
    passed: errorCount === 0,
    errors: errorCount,
    warnings: warningCount,
  };
}

function main(): void {
  const RENDER_MODE = process.argv.includes('--render');
  const FIX_MODE = process.argv.includes('--fix');
  const colors = getColors();

  const startTime = Date.now();
  const files = findMdxFiles(CONTENT_DIR);

  let totalCharts = 0;
  let errorCount = 0;
  let warningCount = 0;
  const allIssues: FileIssueGroup[] = [];

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
    const fileIssues: ChartIssue[] = [];

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
            message: cliResult.error!,
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
    const output: CIOutput = {
      files: files.length,
      charts: totalCharts,
      errors: errorCount,
      warnings: warningCount,
      issues: allIssues,
      duration,
      renderMode: RENDER_MODE && hasCli,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    if (allIssues.length === 0) {
      console.log(`${colors.green}✓ All ${totalCharts} Mermaid diagrams passed validation${colors.reset}`);
      console.log(`${colors.dim}  Checked ${files.length} files in ${duration}ms${colors.reset}\n`);
    } else {
      for (const { file, issues, chartCount } of allIssues) {
        const relPath = file.replace(PROJECT_ROOT + '/', '');
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
