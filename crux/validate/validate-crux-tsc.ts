#!/usr/bin/env node

/**
 * Crux TypeScript Check — ratchet validator with baseline.
 *
 * Runs `tsc --noEmit -p crux/tsconfig.json` and compares the error count
 * against the baseline in `crux-tsc-baseline.txt`. Passes when the current
 * count is at or below baseline; fails if it grows.
 *
 * Why a ratchet rather than strict zero: crux/ has accumulated pre-existing
 * type errors from rapid iteration, and a strict-zero check blocked all
 * sessions on infrastructure work (QUA-338). The ratchet lets new work ship
 * while preventing the count from growing.
 *
 * Usage:
 *   npx tsx crux/validate/validate-crux-tsc.ts            # check
 *   npx tsx crux/validate/validate-crux-tsc.ts --update   # rewrite baseline
 *
 * Drive the baseline back down under QUA-30.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const CI_MODE = process.argv.includes('--ci') || process.env.CI === 'true';
const c = getColors(CI_MODE);

const BASELINE_PATH = path.join(PROJECT_ROOT, 'crux/validate/crux-tsc-baseline.txt');

function findTsc(): string {
  const localTsc = path.join(PROJECT_ROOT, 'apps/web/node_modules/.bin/tsc');
  if (fs.existsSync(localTsc)) return localTsc;
  return 'npx tsc';
}

export function countErrors(): number {
  const tsc = findTsc();
  try {
    execSync(`${tsc} --noEmit -p crux/tsconfig.json`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 0;
  } catch (err: unknown) {
    const output = (err as { stdout?: string; stderr?: string }).stdout || '';
    const stderr = (err as { stdout?: string; stderr?: string }).stderr || '';
    const combined = output + stderr;
    const errorLines = combined
      .split('\n')
      .filter((l) => l.startsWith('crux/') && l.includes('error TS'));
    return errorLines.length;
  }
}

export function readBaseline(): number | null {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  const raw = fs.readFileSync(BASELINE_PATH, 'utf-8').trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function writeBaseline(count: number): void {
  fs.writeFileSync(BASELINE_PATH, `${count}\n`, 'utf-8');
}

export interface CheckResult {
  passed: boolean;
  current: number;
  baseline: number | null;
  message: string;
}

/**
 * Pure comparison logic. Exported for unit tests so the ratchet behavior
 * can be verified without invoking tsc.
 */
export function compareToBaseline(current: number, baseline: number | null): CheckResult {
  if (baseline === null) {
    return {
      passed: false,
      current,
      baseline: null,
      message:
        `Baseline file missing or unreadable at ${path.relative(PROJECT_ROOT, BASELINE_PATH)}. ` +
        `Run \`npx tsx crux/validate/validate-crux-tsc.ts --update\` to create it.`,
    };
  }

  if (current > baseline) {
    return {
      passed: false,
      current,
      baseline,
      message:
        `crux/ TypeScript errors rose from ${baseline} to ${current} (+${current - baseline}). ` +
        `New code added ${current - baseline} type error(s); fix them before shipping. ` +
        `The ratchet only allows the count to fall, never rise (see QUA-30, QUA-338).`,
    };
  }

  if (current < baseline) {
    return {
      passed: true,
      current,
      baseline,
      message:
        `crux/ TypeScript errors dropped from ${baseline} to ${current} (-${baseline - current}). ` +
        `Run \`npx tsx crux/validate/validate-crux-tsc.ts --update\` and commit ` +
        `crux/validate/crux-tsc-baseline.txt to lock in the improvement.`,
    };
  }

  return {
    passed: true,
    current,
    baseline,
    message: `At baseline (${current} crux/ TypeScript error(s))`,
  };
}

export function runCheck(): CheckResult {
  return compareToBaseline(countErrors(), readBaseline());
}

function main(): void {
  const args = process.argv.slice(2);
  const updateMode = args.includes('--update') || args.includes('--update-baseline');

  if (updateMode) {
    const current = countErrors();
    writeBaseline(current);
    console.log(`${c.green}Baseline updated to ${current}.${c.reset}`);
    console.log(`  Wrote: ${path.relative(PROJECT_ROOT, BASELINE_PATH)}`);
    return;
  }

  console.log(`${c.blue}Checking crux/ TypeScript errors against baseline...${c.reset}`);
  const result = runCheck();

  if (!result.passed) {
    console.log(`\n${c.red}${result.message}${c.reset}`);
    console.log(
      `${c.dim}Run: cd apps/web && pnpm exec tsc --noEmit -p ../../crux/tsconfig.json${c.reset}`,
    );
    process.exit(1);
  }

  if (result.baseline !== null && result.current < result.baseline) {
    console.log(`${c.yellow}${result.message}${c.reset}`);
    return;
  }

  console.log(`${c.green}${result.message}${c.reset}`);
}

if (process.argv[1]?.includes('validate-crux-tsc')) {
  main();
}
