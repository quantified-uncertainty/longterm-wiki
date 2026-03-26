#!/usr/bin/env node

/**
 * Crux TypeScript Check — strict zero-error enforcement
 *
 * Runs `tsc --noEmit` on crux/ and fails if any errors are found.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const CI_MODE = process.argv.includes('--ci') || process.env.CI === 'true';
const c = getColors(CI_MODE);

function findTsc(): string {
  // Prefer local tsc from apps/web (where typescript is installed)
  const localTsc = path.join(PROJECT_ROOT, 'apps/web/node_modules/.bin/tsc');
  if (fs.existsSync(localTsc)) return localTsc;
  // Fallback to npx
  return 'npx tsc';
}

function countErrors(): number {
  const tsc = findTsc();
  try {
    execSync(`${tsc} --noEmit -p crux/tsconfig.json`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 0; // No errors
  } catch (err: unknown) {
    const output = (err as { stdout?: string; stderr?: string }).stdout || '';
    const stderr = (err as { stdout?: string; stderr?: string }).stderr || '';
    const combined = output + stderr;
    // Count error lines (each starts with crux/ path)
    const errorLines = combined.split('\n').filter(l => l.startsWith('crux/') && l.includes('error TS'));
    return errorLines.length;
  }
}

function main(): void {
  console.log(`${c.blue}Checking crux/ TypeScript errors...${c.reset}`);

  const currentErrors = countErrors();

  if (currentErrors === 0) {
    console.log(`\n${c.green}No TypeScript errors in crux/ — clean!${c.reset}`);
    process.exit(0);
  }

  console.log(`\n${c.red}crux/ TypeScript: ${currentErrors} error(s) found!${c.reset}`);
  console.log(`${c.dim}Run: cd apps/web && pnpm exec tsc --noEmit -p ../../crux/tsconfig.json${c.reset}`);
  process.exit(1);
}

main();
