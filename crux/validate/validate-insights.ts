#!/usr/bin/env node

/**
 * Insights Validator
 *
 * Thin wrapper for validate-all.ts integration.
 * Runs schema and source path checks on insights.yaml.
 *
 * Usage:
 *   node scripts/validate-insights.ts [--ci]
 *
 * Exit codes:
 *   0 = All checks passed
 *   1 = Validation failed
 */

import * as insights from '../lib/insights.ts';
import type { AllChecksResult, CheckIssue } from '../lib/insights.ts';
import { createLogger } from '../lib/output.ts';
import type { Logger } from '../lib/output.ts';
import { join } from 'path';
import { CONTENT_DIR_ABS as CONTENT_DIR, DATA_DIR_ABS } from '../lib/content-types.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';

const INSIGHTS_PATH: string = join(DATA_DIR_ABS, 'insights');

export async function runCheck(options?: ValidatorOptions): Promise<ValidatorResult> {
  const CI_MODE: boolean = options?.ci ?? process.argv.includes('--ci');
  const log: Logger = createLogger(CI_MODE);

  try {
    // Load insights
    const data = insights.loadInsights(INSIGHTS_PATH);
    const insightsList = data.insights || [];

    // Run validation checks (schema and sources are most important for CI)
    const result: AllChecksResult = insights.runAllChecks(insightsList, CONTENT_DIR, {
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
          r.issues.filter((i: CheckIssue) => i.severity === 'error').map((i: CheckIssue) => ({
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
          const errors = checkResult.issues.filter((i: CheckIssue) => i.severity === 'error');
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
        const warnings: CheckIssue[] = Object.entries(result.results).flatMap(([_, r]) =>
          r.issues.filter((i: CheckIssue) => i.severity === 'warning')
        );
        if (warnings.length > 0) {
          console.log(`  ${c.yellow}${warnings.length} warnings${c.reset}`);
        }
      }
    }

    const totalErrors: number = Object.values(result.results).reduce(
      (sum, r) => sum + r.issues.filter((i: CheckIssue) => i.severity === 'error').length, 0
    );
    const totalWarnings: number = Object.values(result.results).reduce(
      (sum, r) => sum + r.issues.filter((i: CheckIssue) => i.severity === 'warning').length, 0
    );

    return { passed: result.passed, errors: totalErrors, warnings: totalWarnings };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (CI_MODE) {
      console.log(JSON.stringify({
        validator: 'insights',
        passed: false,
        error: message,
      }, null, 2));
    } else {
      log.error(`Error: ${message}`);
    }
    return { passed: false, errors: 1, warnings: 0 };
  }
}

async function main(): Promise<void> {
  const result = await runCheck();
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
