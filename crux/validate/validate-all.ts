#!/usr/bin/env node

/**
 * Master Validation Script
 *
 * Runs all validation checks and aggregates results.
 * Uses the unified validation engine for efficiency where possible.
 *
 * Usage:
 *   npx tsx crux/validate/validate-all.ts [options]
 *
 * Options:
 *   --ci              Output JSON for CI pipelines
 *   --fail-fast       Stop on first failure
 *   --skip=<check>    Skip specific checks (comma-separated)
 *   --fix             Auto-fix fixable issues (unified rules only)
 *
 * Exit codes:
 *   0 = All checks passed
 *   1 = One or more checks failed
 */

import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ValidationEngine, Severity, type Issue } from '../lib/validation-engine.ts';
import { allRules } from '../lib/rules/index.ts';
import { getColors } from '../lib/output.ts';

const __filename: string = fileURLToPath(import.meta.url);
const __dirname: string = dirname(__filename);

const args: string[] = process.argv.slice(2);
const CI_MODE: boolean = args.includes('--ci') || process.env.CI === 'true';
const FAIL_FAST: boolean = args.includes('--fail-fast');
const FIX_MODE: boolean = args.includes('--fix');

// Parse --skip argument
const skipArg: string | undefined = args.find((a: string) => a.startsWith('--skip='));
const skipChecks: string[] = skipArg ? skipArg.replace('--skip=', '').split(',') : [];

const colors = getColors(CI_MODE);

/**
 * Maps check ID to one or more rule IDs used by the unified validation engine.
 */
interface UnifiedChecksMap {
  [checkId: string]: string[];
}

/**
 * Checks that use the unified validation engine (fast, single-pass)
 * Maps check ID to rule ID(s)
 */
const UNIFIED_CHECKS: UnifiedChecksMap = {
  'frontmatter': ['frontmatter-schema'],
  'dollars': ['dollar-signs'],
  'comparisons': ['comparison-operators'],
  'tildes': ['tilde-dollar'],
  'markdown-lists': ['markdown-lists'],
  'bold-labels': ['consecutive-bold-labels'],
  'estimate-boxes': ['estimate-boxes'],
  'placeholders': ['placeholders'],
  'internal-links': ['internal-links'],
  'component-refs': ['component-refs'],
  'sidebar-index': ['sidebar-index'],
  'entitylink-ids': ['entitylink-ids'],
  'prefer-entitylink': ['prefer-entitylink'],
};

/**
 * Descriptor for a legacy validation script that runs as a subprocess.
 */
interface SubprocessCheckDescriptor {
  id: string;
  name: string;
  script: string;
  description: string;
  args?: string[];
}

/**
 * Checks that require subprocess execution (legacy scripts)
 */
const SUBPROCESS_CHECKS: SubprocessCheckDescriptor[] = [
  {
    id: 'data',
    name: 'Data Integrity',
    script: 'validate-data.ts',
    description: 'Entity references, required fields, DataInfoBox props',
  },
  {
    id: 'entity-links',
    name: 'EntityLink Conversion',
    script: 'validate-entity-links.ts',
    description: 'Markdown links that could use EntityLink components',
  },
  {
    id: 'orphans',
    name: 'Orphaned Files',
    script: 'validate-orphaned-files.ts',
    description: 'Backup files, temp files, empty directories',
  },
  {
    id: 'mdx',
    name: 'MDX Syntax',
    script: 'validate-mdx-syntax.ts',
    description: 'Mermaid components, escaped characters, common errors',
  },
  {
    id: 'mdx-compile',
    name: 'MDX Compilation',
    script: 'validate-mdx-compile.ts',
    description: 'Actually compile MDX to catch JSX parsing errors before build',
  },
  {
    id: 'mermaid',
    name: 'Mermaid Diagrams',
    script: 'validate-mermaid.ts',
    description: 'Diagram syntax, subgraph IDs, comparison operators',
  },
  {
    id: 'style',
    name: 'Style Guide Compliance',
    script: 'validate-style-guide.ts',
    description: 'Section structure, magnitude assessment, diagram conventions',
  },
  {
    id: 'staleness',
    name: 'Content Freshness',
    script: 'check-staleness.ts',
    description: 'Review dates, dependency updates, age thresholds',
  },
  {
    id: 'consistency',
    name: 'Cross-Page Consistency',
    script: 'validate-consistency.ts',
    description: 'Probability estimates, causal claims, terminology',
  },
  {
    id: 'sidebar',
    name: 'Sidebar Configuration',
    script: 'validate-sidebar.ts',
    description: 'Index pages have label: Overview and order: 0',
  },
  {
    id: 'types',
    name: 'Type Consistency',
    script: 'validate-types.ts',
    description: 'UI components handle all entity types from schema',
  },
  {
    id: 'schema',
    name: 'YAML Schema Validation',
    script: 'validate-yaml-schema.ts',
    description: 'Entity/resource YAML files match Zod schemas',
  },
  {
    id: 'graph-sync',
    name: 'Graph Node Sync',
    script: 'validate-graph-sync.ts',
    description: 'Individual diagram nodes exist in master graph',
  },
  {
    id: 'insights',
    name: 'Insights Quality',
    script: 'validate-insights.ts',
    description: 'Insight schema, ratings, and source paths',
  },
  // Note: 'quality' check excluded from CI - it's advisory only
  // Run `npm run validate:quality` manually to check quality ratings
];

/**
 * Result from running a subprocess validation check.
 */
interface SubprocessResult {
  check: string;
  name: string;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Result entry for each check in the aggregated results.
 */
interface CheckResult {
  check: string;
  name: string;
  passed?: boolean;
  skipped?: boolean;
  issues?: number;
  errors?: number;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/**
 * Aggregated results from all validation checks.
 */
interface AggregatedResults {
  timestamp: string;
  checks: CheckResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  duration?: string;
}

/**
 * Run a validation script via subprocess
 */
function runSubprocessCheck(check: SubprocessCheckDescriptor): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const scriptPath: string = join(__dirname, check.script);
    const checkArgs: string[] = check.args || [];
    const childArgs: string[] = CI_MODE ? ['--ci', ...checkArgs] : checkArgs;

    // Always register tsx/esm so scripts can import .ts modules
    const runnerArgs: string[] = ['--import', 'tsx/esm', '--no-warnings', scriptPath, ...childArgs];

    const child: ChildProcess = spawn('node', runnerArgs, {
      cwd: process.cwd(),
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (!CI_MODE) {
        process.stdout.write(data);
      }
    });

    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (!CI_MODE) {
        process.stderr.write(data);
      }
    });

    child.on('close', (code: number | null) => {
      resolve({
        check: check.id,
        name: check.name,
        passed: code === 0,
        exitCode: code,
        stdout,
        stderr,
      });
    });

    child.on('error', (err: Error) => {
      resolve({
        check: check.id,
        name: check.name,
        passed: false,
        exitCode: 1,
        error: err.message,
        stdout,
        stderr,
      });
    });
  });
}

async function main(): Promise<void> {
  const startTime: number = Date.now();
  const results: AggregatedResults = {
    timestamp: new Date().toISOString(),
    checks: [],
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
    },
  };

  if (!CI_MODE) {
    console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}${colors.blue}  Content Validation Suite${colors.reset}`);
    console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1: Run unified validation engine (single-pass, efficient)
  // ─────────────────────────────────────────────────────────────────────────

  // Determine which unified checks to run
  const unifiedChecksToRun: Array<{ id: string; ruleIds: string[] }> = Object.entries(UNIFIED_CHECKS)
    .filter(([id]: [string, string[]]) => !skipChecks.includes(id))
    .map(([id, ruleIds]: [string, string[]]) => ({ id, ruleIds }));

  if (unifiedChecksToRun.length > 0) {
    if (!CI_MODE) {
      console.log(`${colors.cyan}▶ Unified Validation Engine${colors.reset}`);
      console.log(`${colors.dim}  Running ${unifiedChecksToRun.length} rule-based checks in single pass${colors.reset}\n`);
    }

    // Create and load engine
    const engine = new ValidationEngine();

    // Register only the rules for checks we're running
    const ruleIdsToRun: string[] = unifiedChecksToRun.flatMap((c) => c.ruleIds);
    for (const rule of allRules) {
      if (ruleIdsToRun.includes(rule.id)) {
        engine.addRule(rule);
      }
    }

    await engine.load();

    // Run validation
    const issues: Issue[] = await engine.validate();

    // Apply fixes if requested
    if (FIX_MODE) {
      const fixableIssues: Issue[] = issues.filter((i: Issue) => i.isFixable);
      if (fixableIssues.length > 0) {
        const { filesFixed, issuesFixed } = engine.applyFixes(fixableIssues);
        if (!CI_MODE) {
          console.log(`${colors.green}  ✓ Auto-fixed ${issuesFixed} issues in ${filesFixed} files${colors.reset}\n`);
        }
      }
    }

    // Group issues by rule and determine pass/fail for each check
    const issuesByRule: Record<string, Issue[]> = {};
    for (const issue of issues) {
      if (!issuesByRule[issue.rule]) {
        issuesByRule[issue.rule] = [];
      }
      issuesByRule[issue.rule].push(issue);
    }

    // Record results for each unified check
    for (const { id, ruleIds } of unifiedChecksToRun) {
      results.summary.total++;

      const checkIssues: Issue[] = ruleIds.flatMap((ruleId: string) => issuesByRule[ruleId] || []);
      const errorCount: number = checkIssues.filter((i: Issue) => i.severity === Severity.ERROR).length;
      const passed: boolean = errorCount === 0;

      if (passed) {
        results.summary.passed++;
      } else {
        results.summary.failed++;
      }

      results.checks.push({
        check: id,
        name: id,
        passed,
        issues: checkIssues.length,
        errors: errorCount,
      });

      if (!CI_MODE) {
        if (passed) {
          console.log(`  ${colors.green}✓${colors.reset} ${id}`);
        } else {
          console.log(`  ${colors.red}✗${colors.reset} ${id} (${errorCount} errors)`);
          // Show first few issues
          for (const issue of checkIssues.slice(0, 3)) {
            console.log(`    ${colors.dim}${issue.file}:${issue.line}: ${issue.message.slice(0, 60)}...${colors.reset}`);
          }
          if (checkIssues.length > 3) {
            console.log(`    ${colors.dim}... and ${checkIssues.length - 3} more${colors.reset}`);
          }
        }
      }

      if (!passed && FAIL_FAST) {
        if (!CI_MODE) {
          console.log(`\n${colors.yellow}Stopping due to --fail-fast${colors.reset}\n`);
        }
        outputResults(results, startTime);
        process.exit(1);
      }
    }

    // Record skipped unified checks
    for (const [id] of Object.entries(UNIFIED_CHECKS)) {
      if (skipChecks.includes(id)) {
        results.summary.total++;
        results.summary.skipped++;
        results.checks.push({ check: id, name: id, skipped: true });
      }
    }

    if (!CI_MODE) {
      console.log(`\n${colors.dim}${'─'.repeat(50)}${colors.reset}\n`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2: Run subprocess checks (legacy scripts)
  // ─────────────────────────────────────────────────────────────────────────

  for (const check of SUBPROCESS_CHECKS) {
    results.summary.total++;

    if (skipChecks.includes(check.id)) {
      results.summary.skipped++;
      results.checks.push({
        check: check.id,
        name: check.name,
        skipped: true,
      });
      if (!CI_MODE) {
        console.log(`${colors.dim}⊘ ${check.name} (skipped)${colors.reset}\n`);
      }
      continue;
    }

    if (!CI_MODE) {
      console.log(`${colors.cyan}▶ ${check.name}${colors.reset}`);
      console.log(`${colors.dim}  ${check.description}${colors.reset}\n`);
    }

    const result: SubprocessResult = await runSubprocessCheck(check);
    results.checks.push(result);

    if (result.passed) {
      results.summary.passed++;
      if (!CI_MODE) {
        console.log(`\n${colors.green}✓ ${check.name} passed${colors.reset}\n`);
      }
    } else {
      results.summary.failed++;
      if (!CI_MODE) {
        console.log(`\n${colors.red}✗ ${check.name} failed${colors.reset}\n`);
      }

      if (FAIL_FAST) {
        if (!CI_MODE) {
          console.log(`${colors.yellow}Stopping due to --fail-fast${colors.reset}\n`);
        }
        break;
      }
    }

    if (!CI_MODE && check !== SUBPROCESS_CHECKS[SUBPROCESS_CHECKS.length - 1]) {
      console.log(`${colors.dim}${'─'.repeat(50)}${colors.reset}\n`);
    }
  }

  outputResults(results, startTime);
  process.exit(results.summary.failed > 0 ? 1 : 0);
}

function outputResults(results: AggregatedResults, startTime: number): void {
  const duration: string = ((Date.now() - startTime) / 1000).toFixed(2);
  results.duration = `${duration}s`;

  if (CI_MODE) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bold}  Summary${colors.reset}`);
    console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

    console.log(`  Total:   ${results.summary.total}`);
    console.log(`  ${colors.green}Passed:  ${results.summary.passed}${colors.reset}`);
    if (results.summary.failed > 0) {
      console.log(`  ${colors.red}Failed:  ${results.summary.failed}${colors.reset}`);
    }
    if (results.summary.skipped > 0) {
      console.log(`  ${colors.dim}Skipped: ${results.summary.skipped}${colors.reset}`);
    }
    console.log(`\n  Duration: ${duration}s\n`);

    if (results.summary.failed === 0) {
      console.log(`${colors.green}${colors.bold}✅ All checks passed!${colors.reset}\n`);
    } else {
      console.log(`${colors.red}${colors.bold}❌ ${results.summary.failed} check(s) failed${colors.reset}\n`);

      for (const check of results.checks) {
        if (!check.passed && !check.skipped) {
          console.log(`  ${colors.red}• ${check.name || check.check}${colors.reset}`);
        }
      }
      console.log();
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
