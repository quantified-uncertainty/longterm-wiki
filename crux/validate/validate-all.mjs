#!/usr/bin/env node

/**
 * Master Validation Script
 *
 * Runs all validation checks and aggregates results.
 * Uses the unified validation engine for efficiency where possible.
 *
 * Usage:
 *   node scripts/validate-all.mjs [options]
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

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ValidationEngine, Severity } from '../lib/validation-engine.js';
import { allRules } from '../lib/rules/index.js';
import { getColors } from '../lib/output.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const CI_MODE = args.includes('--ci') || process.env.CI === 'true';
const FAIL_FAST = args.includes('--fail-fast');
const FIX_MODE = args.includes('--fix');

// Parse --skip argument
const skipArg = args.find(a => a.startsWith('--skip='));
const skipChecks = skipArg ? skipArg.replace('--skip=', '').split(',') : [];

const colors = getColors(CI_MODE);

/**
 * Checks that use the unified validation engine (fast, single-pass)
 * Maps check ID to rule ID(s)
 */
const UNIFIED_CHECKS = {
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
 * Checks that require subprocess execution (legacy scripts)
 */
const SUBPROCESS_CHECKS = [
  {
    id: 'data',
    name: 'Data Integrity',
    script: 'validate-data.mjs',
    description: 'Entity references, required fields, DataInfoBox props',
  },
  {
    id: 'entity-links',
    name: 'EntityLink Conversion',
    script: 'validate-entity-links.mjs',
    description: 'Markdown links that could use EntityLink components',
  },
  {
    id: 'orphans',
    name: 'Orphaned Files',
    script: 'validate-orphaned-files.mjs',
    description: 'Backup files, temp files, empty directories',
  },
  {
    id: 'mdx',
    name: 'MDX Syntax',
    script: 'validate-mdx-syntax.mjs',
    description: 'Mermaid components, escaped characters, common errors',
  },
  {
    id: 'mdx-compile',
    name: 'MDX Compilation',
    script: 'validate-mdx-compile.mjs',
    description: 'Actually compile MDX to catch JSX parsing errors before build',
  },
  {
    id: 'mermaid',
    name: 'Mermaid Diagrams',
    script: 'validate-mermaid.mjs',
    description: 'Diagram syntax, subgraph IDs, comparison operators',
  },
  {
    id: 'style',
    name: 'Style Guide Compliance',
    script: 'validate-style-guide.mjs',
    description: 'Section structure, magnitude assessment, diagram conventions',
  },
  {
    id: 'staleness',
    name: 'Content Freshness',
    script: 'check-staleness.mjs',
    description: 'Review dates, dependency updates, age thresholds',
  },
  {
    id: 'consistency',
    name: 'Cross-Page Consistency',
    script: 'validate-consistency.mjs',
    description: 'Probability estimates, causal claims, terminology',
  },
  {
    id: 'sidebar',
    name: 'Sidebar Configuration',
    script: 'validate-sidebar.mjs',
    description: 'Index pages have label: Overview and order: 0',
  },
  {
    id: 'sidebar-labels',
    name: 'Sidebar Label Names',
    script: 'validate-sidebar-labels.mjs',
    description: 'Sidebar labels use proper English names, not kebab-case',
  },
  {
    id: 'types',
    name: 'Type Consistency',
    script: 'validate-types.mjs',
    description: 'UI components handle all entity types from schema',
  },
  {
    id: 'schema',
    name: 'YAML Schema Validation',
    script: 'validate-yaml-schema.mjs',
    description: 'Entity/resource YAML files match Zod schemas',
  },
  {
    id: 'graph-sync',
    name: 'Graph Node Sync',
    script: 'validate-graph-sync.mjs',
    description: 'Individual diagram nodes exist in master graph',
  },
  {
    id: 'insights',
    name: 'Insights Quality',
    script: 'validate-insights.mjs',
    description: 'Insight schema, ratings, and source paths',
  },
  // Note: 'quality' check excluded from CI - it's advisory only
  // Run `npm run validate:quality` manually to check quality ratings
];

/**
 * Run a validation script via subprocess
 */
function runSubprocessCheck(check) {
  return new Promise((resolve) => {
    const scriptPath = join(__dirname, check.script);
    const checkArgs = check.args || [];
    const childArgs = CI_MODE ? ['--ci', ...checkArgs] : checkArgs;

    // Always register tsx/esm so scripts can import .ts modules
    const runnerArgs = ['--import', 'tsx/esm', '--no-warnings', scriptPath, ...childArgs];

    const child = spawn('node', runnerArgs, {
      cwd: process.cwd(),
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (!CI_MODE) {
        process.stdout.write(data);
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (!CI_MODE) {
        process.stderr.write(data);
      }
    });

    child.on('close', (code) => {
      resolve({
        check: check.id,
        name: check.name,
        passed: code === 0,
        exitCode: code,
        stdout,
        stderr,
      });
    });

    child.on('error', (err) => {
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

async function main() {
  const startTime = Date.now();
  const results = {
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
  const unifiedChecksToRun = Object.entries(UNIFIED_CHECKS)
    .filter(([id]) => !skipChecks.includes(id))
    .map(([id, ruleIds]) => ({ id, ruleIds }));

  if (unifiedChecksToRun.length > 0) {
    if (!CI_MODE) {
      console.log(`${colors.cyan}▶ Unified Validation Engine${colors.reset}`);
      console.log(`${colors.dim}  Running ${unifiedChecksToRun.length} rule-based checks in single pass${colors.reset}\n`);
    }

    // Create and load engine
    const engine = new ValidationEngine();

    // Register only the rules for checks we're running
    const ruleIdsToRun = unifiedChecksToRun.flatMap(c => c.ruleIds);
    for (const rule of allRules) {
      if (ruleIdsToRun.includes(rule.id)) {
        engine.addRule(rule);
      }
    }

    await engine.load();

    // Run validation
    const issues = await engine.validate();

    // Apply fixes if requested
    if (FIX_MODE) {
      const fixableIssues = issues.filter(i => i.isFixable);
      if (fixableIssues.length > 0) {
        const { filesFixed, issuesFixed } = engine.applyFixes(fixableIssues);
        if (!CI_MODE) {
          console.log(`${colors.green}  ✓ Auto-fixed ${issuesFixed} issues in ${filesFixed} files${colors.reset}\n`);
        }
      }
    }

    // Group issues by rule and determine pass/fail for each check
    const issuesByRule = {};
    for (const issue of issues) {
      if (!issuesByRule[issue.rule]) {
        issuesByRule[issue.rule] = [];
      }
      issuesByRule[issue.rule].push(issue);
    }

    // Record results for each unified check
    for (const { id, ruleIds } of unifiedChecksToRun) {
      results.summary.total++;

      const checkIssues = ruleIds.flatMap(ruleId => issuesByRule[ruleId] || []);
      const errorCount = checkIssues.filter(i => i.severity === Severity.ERROR).length;
      const passed = errorCount === 0;

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

    const result = await runSubprocessCheck(check);
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

function outputResults(results, startTime) {
  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
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

main();
