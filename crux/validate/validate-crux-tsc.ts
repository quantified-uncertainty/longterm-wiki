#!/usr/bin/env node

/**
 * Crux TypeScript Check — baseline-guarded
 *
 * Runs `tsc --noEmit` on crux/ and compares the error count to a stored
 * baseline. Fails if new errors are introduced, passes if error count
 * stays the same or decreases.
 *
 * Baseline file: crux/validate/crux-tsc-baseline.txt (single integer)
 *
 * When errors are fixed, update the baseline:
 *   npx tsx crux/validate/validate-crux-tsc.ts --update-baseline
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const BASELINE_FILE = path.join(PROJECT_ROOT, 'crux/validate/crux-tsc-baseline.txt');
const CI_MODE = process.argv.includes('--ci') || process.env.CI === 'true';
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
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

function readBaseline(): number {
  try {
    const content = fs.readFileSync(BASELINE_FILE, 'utf-8').trim();
    return parseInt(content, 10);
  } catch {
    return 0;
  }
}

function writeBaseline(count: number): void {
  fs.writeFileSync(BASELINE_FILE, `${count}\n`);
}

function main(): void {
  console.log(`${c.blue}Checking crux/ TypeScript errors against baseline...${c.reset}`);

  const currentErrors = countErrors();
  const baseline = readBaseline();

  if (UPDATE_BASELINE) {
    writeBaseline(currentErrors);
    console.log(`${c.green}Baseline updated: ${currentErrors} errors${c.reset}`);
    process.exit(0);
  }

  if (currentErrors === 0) {
    console.log(`\n${c.green}No TypeScript errors in crux/ — clean!${c.reset}`);
    if (baseline > 0) {
      writeBaseline(0);
      console.log(`${c.dim}Baseline auto-updated to 0${c.reset}`);
    }
    process.exit(0);
  }

  if (currentErrors <= baseline) {
    console.log(`\n${c.green}crux/ TypeScript: ${currentErrors} errors (baseline: ${baseline}) — no regressions${c.reset}`);
    if (currentErrors < baseline) {
      console.log(`${c.dim}Progress! ${baseline - currentErrors} errors fixed since last baseline.${c.reset}`);
      // Auto-ratchet: lower the baseline when errors are fixed
      writeBaseline(currentErrors);
      console.log(`${c.dim}Baseline auto-updated to ${currentErrors}${c.reset}`);
    }
    process.exit(0);
  }

  // Error count increased — fail
  const newErrors = currentErrors - baseline;
  console.log(`\n${c.red}crux/ TypeScript: ${currentErrors} errors (baseline: ${baseline}) — ${newErrors} NEW error(s) introduced!${c.reset}`);
  console.log(`${c.dim}Fix the new errors or update the baseline: npx tsx crux/validate/validate-crux-tsc.ts --update-baseline${c.reset}`);
  process.exit(1);
}

main();
