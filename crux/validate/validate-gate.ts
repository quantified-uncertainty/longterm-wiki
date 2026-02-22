#!/usr/bin/env node

/**
 * Gate Validation — CI-blocking checks in one command
 *
 * Runs the same checks that CI enforces, locally, before push.
 * Used by .githooks/pre-push to mechanically block bad pushes.
 *
 * Steps (fast mode, default):
 *   1. Build data layer (required for validation + tests)
 *   2. Auto-fix escaping + markdown (with --fix)
 *   3. [Parallel] Run vitest tests
 *      [Parallel] Unified blocking rules (MDX syntax, frontmatter, numeric IDs, EntityLink)
 *      [Parallel] YAML schema validation
 *      [Parallel] TypeScript type check
 *
 * With --full:
 *   4. Full Next.js production build
 *
 * Exit codes:
 *   0 = All checks passed
 *   1 = One or more checks failed
 */

import { execSync, spawn, type ChildProcess } from 'child_process';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';

const args: string[] = process.argv.slice(2);
const FIX_MODE: boolean = args.includes('--fix');
const CI_MODE: boolean = args.includes('--ci') || process.env.CI === 'true';

/**
 * Auto-detect whether --full (Next.js build) is needed based on changed files.
 * Triggers when the diff includes app page components or data files that are
 * prerendered at build time (e.g. auto-update YAML that dashboards read).
 */
function shouldAutoEscalateToFull(): boolean {
  try {
    // Check all files changed on the branch vs main (covers all commits being pushed).
    // Falls back to HEAD~1 if merge-base fails (e.g. shallow clone).
    let diffOutput = '';
    try {
      const base = execSync('git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null',
        { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
      if (base) {
        diffOutput = execSync(`git diff --name-only ${base} HEAD`,
          { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
      }
    } catch {
      diffOutput = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null || echo ""',
        { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
    }
    if (!diffOutput) return false;

    const files = diffOutput.split('\n');
    return files.some(f =>
      // App page components (prerendered by Next.js)
      f.startsWith('apps/web/src/app/') ||
      // Auto-update run data (read by dashboard pages at build time)
      f.startsWith('data/auto-update/runs/') ||
      // Auto-update state/sources (read by dashboard pages at build time)
      (f.startsWith('data/auto-update/') && f.endsWith('.yaml'))
    );
  } catch {
    return false;
  }
}

const EXPLICIT_FULL: boolean = args.includes('--full');
const AUTO_FULL: boolean = !EXPLICIT_FULL && shouldAutoEscalateToFull();
const FULL_MODE: boolean = EXPLICIT_FULL || AUTO_FULL;

const c = getColors(CI_MODE);

interface Step {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
}

const APP_DIR = `${PROJECT_ROOT}/apps/web`;

// Phase 1: Must run first — everything else depends on this
const BUILD_DATA_STEP: Step = {
  id: 'build-data',
  name: 'Build data layer',
  command: 'node',
  args: ['--import', 'tsx/esm', 'scripts/build-data.mjs'],
  cwd: APP_DIR,
};

// Phase 2 (--fix only): Auto-fix before validation
const FIX_STEPS: Step[] = [
  {
    id: 'fix-escaping',
    name: 'Auto-fix escaping',
    command: 'pnpm',
    args: ['crux', 'fix', 'escaping'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'fix-markdown',
    name: 'Auto-fix markdown',
    command: 'pnpm',
    args: ['crux', 'fix', 'markdown'],
    cwd: PROJECT_ROOT,
  },
];

// Blocking unified rules — merged into one subprocess invocation so MDX files are
// loaded once instead of once-per-rule. Add new CI-blocking rules here.
const UNIFIED_BLOCKING_RULES = [
  'comparison-operators',
  'dollar-signs',
  'frontmatter-schema',
  'no-quoted-subcategory',
  'numeric-id-integrity',
  'prefer-entitylink',
];

// Phase 3: Independent checks — run in parallel after build-data completes.
// All steps in this group always run to completion so all errors are reported at once.
const PARALLEL_STEPS: Step[] = [
  {
    id: 'test',
    name: 'Run tests',
    command: 'pnpm',
    args: ['test'],
    cwd: APP_DIR,
  },
  {
    id: 'unified-blocking',
    name: 'Unified blocking rules (MDX syntax, frontmatter, numeric IDs, EntityLink)',
    command: 'pnpm',
    args: [
      'crux', 'validate', 'unified',
      `--rules=${UNIFIED_BLOCKING_RULES.join(',')}`,
      '--errors-only',
    ],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'yaml-schema',
    name: 'YAML schema (blocking)',
    command: 'pnpm',
    args: ['crux', 'validate', 'schema'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'typecheck',
    name: 'TypeScript type check',
    command: 'npx',
    args: ['tsc', '--noEmit'],
    cwd: APP_DIR,
  },
  {
    id: 'returning-guard',
    name: '.returning() guard check',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-returning-guard.ts'],
    cwd: PROJECT_ROOT,
  },
];

// Phase 4 (--full only): Runs after all validations pass
const BUILD_STEP: Step = {
  id: 'build',
  name: 'Full Next.js build',
  command: 'pnpm',
  args: ['build'],
  cwd: APP_DIR,
};

interface StepResult {
  id: string;
  name: string;
  passed: boolean;
  duration: number;
  exitCode: number | null;
  capturedOutput: string;
}

/**
 * Run a single step.
 * When buffer=true (parallel mode), output is always captured and never streamed.
 * When buffer=false (sequential mode), output is streamed live in non-CI mode.
 */
function runStep(step: Step, buffer = false): Promise<StepResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(step.command, step.args, {
      cwd: step.cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let capturedOutput = '';

    child.stdout!.on('data', (data: Buffer) => {
      if (!CI_MODE && !buffer) {
        process.stdout.write(data);
      } else {
        capturedOutput += data.toString();
      }
    });

    child.stderr!.on('data', (data: Buffer) => {
      if (!CI_MODE && !buffer) {
        process.stderr.write(data);
      } else {
        capturedOutput += data.toString();
      }
    });

    child.on('close', (code: number | null) => {
      // In CI mode, dump captured output when a step fails so errors are
      // visible in workflow logs (otherwise they're silently discarded).
      if (CI_MODE && code !== 0 && capturedOutput) {
        process.stdout.write(capturedOutput);
      }
      resolve({
        id: step.id,
        name: step.name,
        passed: code === 0,
        duration: Date.now() - start,
        exitCode: code,
        capturedOutput,
      });
    });

    child.on('error', (err: Error) => {
      const errMsg = `Error spawning ${step.command}: ${err.message}\n`;
      if (!CI_MODE && !buffer) {
        process.stderr.write(errMsg);
      } else {
        capturedOutput += errMsg;
      }
      resolve({
        id: step.id,
        name: step.name,
        passed: false,
        duration: Date.now() - start,
        exitCode: 1,
        capturedOutput,
      });
    });
  });
}

/** Run a single step sequentially, streaming output live, and print a pass/fail status line. */
async function runSequential(step: Step): Promise<StepResult> {
  if (!CI_MODE) {
    console.log(`${c.cyan}▶ ${step.name}${c.reset}`);
  }
  const result = await runStep(step, false);
  if (!CI_MODE) {
    if (result.passed) {
      console.log(`${c.green}✓ ${step.name}${c.reset} ${c.dim}(${formatMs(result.duration)})${c.reset}\n`);
    } else {
      console.log(`${c.red}✗ ${step.name} FAILED${c.reset} ${c.dim}(${formatMs(result.duration)})${c.reset}\n`);
    }
  }
  return result;
}

/**
 * Run multiple steps in parallel (buffering output), then print results in order.
 * All steps run to completion even if some fail — gives full error report in one pass.
 */
async function runParallel(steps: Step[]): Promise<StepResult[]> {
  if (!CI_MODE) {
    const names = steps.map(s => s.name).join(', ');
    console.log(`${c.cyan}▶ Running in parallel: ${names}${c.reset}\n`);
  }

  const results = await Promise.all(steps.map(s => runStep(s, true)));

  // Print buffered output in deterministic (step definition) order
  for (const result of results) {
    if (!CI_MODE) {
      if (result.passed) {
        console.log(`${c.green}✓ ${result.name}${c.reset} ${c.dim}(${formatMs(result.duration)})${c.reset}`);
      } else {
        console.log(`${c.red}✗ ${result.name} FAILED${c.reset} ${c.dim}(${formatMs(result.duration)})${c.reset}`);
      }
      if (result.capturedOutput.trim()) {
        process.stdout.write(result.capturedOutput);
      }
      console.log();
    } else if (!result.passed && result.capturedOutput) {
      process.stdout.write(result.capturedOutput);
    }
  }

  return results;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const totalStart = Date.now();
  const allResults: StepResult[] = [];

  const totalSteps = 1 + (FIX_MODE ? FIX_STEPS.length : 0) + PARALLEL_STEPS.length + (FULL_MODE ? 1 : 0);

  if (!CI_MODE) {
    const mode = FULL_MODE ? 'full' : 'fast';
    console.log(`\n${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    console.log(`${c.bold}${c.blue}  Gate Check (${mode})${c.reset}`);
    console.log(`${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
    if (AUTO_FULL) {
      console.log(`${c.dim}  Auto-escalated to full build (app pages or data files changed)${c.reset}`);
    }
    console.log(`${c.dim}  Running ${totalSteps} CI-blocking checks (${PARALLEL_STEPS.length} in parallel)...${c.reset}\n`);
  }

  // ── Phase 1: Build data (prerequisite for everything) ──────────────────────
  const buildDataResult = await runSequential(BUILD_DATA_STEP);
  allResults.push(buildDataResult);
  if (!buildDataResult.passed) {
    printSummary(allResults, totalStart);
    process.exit(1);
  }

  // ── Phase 2: Auto-fix (sequential, must run before validation) ─────────────
  if (FIX_MODE) {
    for (const step of FIX_STEPS) {
      const result = await runSequential(step);
      allResults.push(result);
      if (!result.passed) {
        printSummary(allResults, totalStart);
        process.exit(1);
      }
    }
  }

  // ── Phase 3: Independent checks in parallel ────────────────────────────────
  const parallelResults = await runParallel(PARALLEL_STEPS);
  allResults.push(...parallelResults);
  if (parallelResults.some(r => !r.passed)) {
    printSummary(allResults, totalStart);
    process.exit(1);
  }

  // ── Phase 4: Full Next.js build (only if all other checks pass) ────────────
  if (FULL_MODE) {
    const buildResult = await runSequential(BUILD_STEP);
    allResults.push(buildResult);
    if (!buildResult.passed) {
      printSummary(allResults, totalStart);
      process.exit(1);
    }
  }

  printSummary(allResults, totalStart);
  process.exit(0);
}

function printSummary(results: StepResult[], totalStart: number): void {
  const totalDuration = Date.now() - totalStart;
  const passed = results.every((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  if (CI_MODE) {
    console.log(JSON.stringify({ passed, results: results.map(r => ({ id: r.id, name: r.name, passed: r.passed, duration: r.duration, exitCode: r.exitCode })), duration: formatMs(totalDuration) }));
  } else {
    console.log(`${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    if (passed) {
      console.log(`${c.green}${c.bold}  ✅ All ${results.length} gate checks passed${c.reset} ${c.dim}(${formatMs(totalDuration)})${c.reset}`);
    } else {
      console.log(`${c.red}${c.bold}  ❌ Gate check failed${c.reset} ${c.dim}(${formatMs(totalDuration)})${c.reset}`);
      for (const f of failed) {
        console.log(`${c.red}  • ${f.name}${c.reset}`);
      }
    }
    console.log(`${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
  }
}

main();
