#!/usr/bin/env node

/**
 * Insights Validator
 *
 * Thin wrapper for validate-all.mjs integration.
 * Runs schema and source path checks on insights.yaml.
 *
 * Usage:
 *   node scripts/validate-insights.mjs [--ci]
 *
 * Exit codes:
 *   0 = All checks passed
 *   1 = Validation failed
 */

import * as insights from '../lib/insights.mjs';
import { createLogger } from '../lib/output.mjs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CI_MODE = process.argv.includes('--ci');

// Resolve paths - scripts are now in scripts/validate/ subdirectory
const APP_ROOT = join(__dirname, '../..');
const INSIGHTS_PATH = join(APP_ROOT, 'src', 'data', 'insights');
const CONTENT_DIR = join(APP_ROOT, 'src', 'content', 'docs');

async function main() {
  const log = createLogger(CI_MODE);

  try {
    // Load insights
    const data = insights.loadInsights(INSIGHTS_PATH);
    const insightsList = data.insights || [];

    // Run validation checks (schema and sources are most important for CI)
    const result = insights.runAllChecks(insightsList, CONTENT_DIR, {
      only: ['schema', 'sources', 'ratings'],
    });

    if (CI_MODE) {
      // Clean JSON output for CI
      console.log(JSON.stringify({
        validator: 'insights',
        passed: result.passed,
        total: result.total,
        checksRun: result.checksRun,
        totalIssues: result.totalIssues,
        issues: Object.entries(result.results).flatMap(([check, r]) =>
          r.issues.filter(i => i.severity === 'error').map(i => ({
            check,
            ...i,
          }))
        ),
      }, null, 2));
    } else {
      // Human-readable output
      const c = log.colors;

      if (!result.passed) {
        console.log(`${c.red}${c.bold}Insights validation failed${c.reset}\n`);

        for (const [checkName, checkResult] of Object.entries(result.results)) {
          const errors = checkResult.issues.filter(i => i.severity === 'error');
          if (errors.length > 0) {
            console.log(`${c.red}✗ ${checkName}${c.reset}`);
            for (const issue of errors) {
              console.log(`  ${c.red}${issue.message}${c.reset}`);
            }
            console.log();
          }
        }
      } else {
        console.log(`${c.green}✓ Insights validation passed${c.reset}`);
        console.log(`  ${c.dim}${result.total} insights, ${result.checksRun} checks${c.reset}`);

        // Show warnings
        const warnings = Object.entries(result.results).flatMap(([_, r]) =>
          r.issues.filter(i => i.severity === 'warning')
        );
        if (warnings.length > 0) {
          console.log(`  ${c.yellow}${warnings.length} warnings${c.reset}`);
        }
      }
    }

    process.exit(result.passed ? 0 : 1);
  } catch (err) {
    if (CI_MODE) {
      console.log(JSON.stringify({
        validator: 'insights',
        passed: false,
        error: err.message,
      }, null, 2));
    } else {
      log.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

main();
