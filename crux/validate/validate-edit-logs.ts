#!/usr/bin/env node

/**
 * Edit Log Validator
 *
 * Edit logs are now stored exclusively in PostgreSQL (wiki-server).
 * The server validates entries on insert (schema, enum values, date format).
 *
 * This validator is a no-op since the YAML files have been removed (#485).
 * Kept as a stub so callers that reference runCheck don't break.
 *
 * Usage:
 *   npx tsx crux/validate/validate-edit-logs.ts
 *   npx tsx crux/validate/validate-edit-logs.ts --ci
 */

import { fileURLToPath } from 'url';
import { getColors } from '../lib/output.ts';

const args: string[] = process.argv.slice(2);
const CI_MODE: boolean = args.includes('--ci') || process.env.CI === 'true';
const colors = getColors(CI_MODE);

function validate(): { passed: boolean; errors: number; warnings: number } {
  if (CI_MODE) {
    console.log(JSON.stringify({ errors: 0, warnings: 0, issues: [], note: 'Edit logs stored in PostgreSQL — YAML validation skipped' }, null, 2));
  } else {
    console.log(`${colors.dim}Edit logs stored in PostgreSQL — YAML validation skipped${colors.reset}`);
  }
  return { passed: true, errors: 0, warnings: 0 };
}

function main(): void {
  const result = validate();
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export { validate as runCheck };
