#!/usr/bin/env node
/**
 * Validate that all nodes in individual entity diagrams exist in the master graph.
 *
 * Previously validated AI Transition Model graph data. The ATM section has been
 * removed from this wiki, so this validator now always passes.
 *
 * Usage:
 *   node scripts/validate-graph-sync.ts
 *
 * Exit codes:
 *   0 - Always passes (no ATM data to validate)
 */

import { fileURLToPath } from 'url';
import type { ValidatorResult, ValidatorOptions } from './types.ts';

export function runCheck(_options?: ValidatorOptions): ValidatorResult {
  console.log('Graph sync validation skipped (AI Transition Model section removed)');
  return { passed: true, errors: 0, warnings: 0 };
}

function main(): void {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
