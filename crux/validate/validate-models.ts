#!/usr/bin/env node

/**
 * Model Freshness Validator
 *
 * Warns when the configured Claude models haven't been verified
 * as current in more than 60 days.
 *
 * Usage:
 *   node scripts/validate-models.ts [--ci]
 *
 * Exit codes:
 *   0 = All checks passed (or warning-only)
 *   1 = Validation failed
 */

import { fileURLToPath } from 'url';
import { MODELS, MODELS_LAST_VERIFIED } from '../lib/anthropic.ts';
import { createLogger } from '../lib/output.ts';
import type { ValidatorResult, ValidatorOptions } from './types.ts';

const WARN_AFTER_DAYS = 60;

export async function runCheck(options?: ValidatorOptions): Promise<ValidatorResult> {
  const CI_MODE = options?.ci ?? process.argv.includes('--ci');
  const log = createLogger(CI_MODE);
  const c = log.colors;

  const lastVerified = new Date(MODELS_LAST_VERIFIED);
  const now = new Date();
  const daysSince = Math.floor((now.getTime() - lastVerified.getTime()) / (1000 * 60 * 60 * 24));
  const isStale = daysSince > WARN_AFTER_DAYS;

  if (CI_MODE) {
    console.log(JSON.stringify({
      validator: 'models',
      passed: true,
      lastVerified: MODELS_LAST_VERIFIED,
      daysSince,
      warnings: isStale ? 1 : 0,
      models: MODELS,
    }, null, 2));
  } else if (isStale) {
    console.log(`${c.yellow}⚠ Model versions last verified ${daysSince} days ago (${MODELS_LAST_VERIFIED})${c.reset}`);
    console.log(`  ${c.dim}Check https://docs.anthropic.com/en/docs/about-claude/models for updates${c.reset}`);
    console.log(`  ${c.dim}Current models:${c.reset}`);
    for (const [name, id] of Object.entries(MODELS)) {
      console.log(`    ${c.dim}${name}: ${id}${c.reset}`);
    }
    console.log(`  ${c.dim}Update MODELS_LAST_VERIFIED in crux/lib/anthropic.ts after checking${c.reset}`);
  } else {
    console.log(`${c.green}✓ Model versions verified ${daysSince} days ago${c.reset}`);
  }

  return { passed: true, errors: 0, warnings: isStale ? 1 : 0 };
}

async function main(): Promise<void> {
  const result = await runCheck();
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
