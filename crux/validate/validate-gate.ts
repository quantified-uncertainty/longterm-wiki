#!/usr/bin/env node

/**
 * Gate Validation — CI-blocking checks in one command
 *
 * Runs the same checks that CI enforces, locally, before push.
 * Used by .githooks/pre-push to mechanically block bad pushes.
 *
 * Steps (fast mode, default):
 *   1. Build data layer (required for validation + tests)
 *   2. Run vitest tests
 *   3. Auto-fix escaping + markdown (with --fix)
 *   4. MDX syntax (comparison-operators, dollar-signs)
 *   5. YAML schema validation
 *   6. Frontmatter schema validation
 *   7. Numeric ID integrity (cross-entity/page duplicate detection)
 *   8. TypeScript type check
 *
 * With --full:
 *   9. Full Next.js production build
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

const STEPS: Step[] = [
  {
    id: 'build-data',
    name: 'Build data layer',
    command: 'node',
    args: ['--import', 'tsx/esm', 'scripts/build-data.mjs'],
    cwd: APP_DIR,
  },
  {
    id: 'test',
    name: 'Run tests',
    command: 'pnpm',
    args: ['test'],
    cwd: APP_DIR,
  },
  ...(FIX_MODE ? [{
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
  }] : []),
  {
    id: 'mdx-syntax',
    name: 'MDX syntax (blocking)',
    command: 'pnpm',
    args: ['crux', 'validate', 'unified', '--rules=comparison-operators,dollar-signs', '--errors-only'],
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
    id: 'frontmatter',
    name: 'Frontmatter schema (blocking)',
    command: 'pnpm',
    args: ['crux', 'validate', 'unified', '--rules=frontmatter-schema', '--errors-only'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'numeric-id-integrity',
    name: 'Numeric ID integrity (blocking)',
    command: 'pnpm',
    args: ['crux', 'validate', 'unified', '--rules=numeric-id-integrity', '--errors-only'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'typecheck',
    name: 'TypeScript type check',
    command: 'npx',
    args: ['tsc', '--noEmit'],
    cwd: APP_DIR,
  },
];

if (FULL_MODE) {
  STEPS.push({
    id: 'build',
    name: 'Full Next.js build',
    command: 'pnpm',
    args: ['build'],
    cwd: APP_DIR,
  });
}

interface StepResult {
  id: string;
  name: string;
  passed: boolean;
  duration: number;
  exitCode: number | null;
}

function runStep(step: Step): Promise<StepResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(step.command, step.args, {
      cwd: step.cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
      // Stream output in non-CI mode so user sees progress
      if (!CI_MODE) {
        process.stdout.write(data);
      }
    });

    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
      if (!CI_MODE) {
        process.stderr.write(data);
      }
    });

    child.on('close', (code: number | null) => {
      // In CI mode, dump captured output when a step fails so errors are
      // visible in workflow logs (otherwise they're silently discarded).
      if (CI_MODE && code !== 0) {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
      }
      resolve({
        id: step.id,
        name: step.name,
        passed: code === 0,
        duration: Date.now() - start,
        exitCode: code,
      });
    });

    child.on('error', (err: Error) => {
      // Print error so it's visible
      if (!CI_MODE) {
        process.stderr.write(`Error spawning ${step.command}: ${err.message}\n`);
      }
      resolve({
        id: step.id,
        name: step.name,
        passed: false,
        duration: Date.now() - start,
        exitCode: 1,
      });
    });
  });
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const totalStart = Date.now();
  const results: StepResult[] = [];

  if (!CI_MODE) {
    const mode = FULL_MODE ? 'full' : 'fast';
    console.log(`\n${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    console.log(`${c.bold}${c.blue}  Gate Check (${mode})${c.reset}`);
    console.log(`${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
    if (AUTO_FULL) {
      console.log(`${c.dim}  Auto-escalated to full build (app pages or data files changed)${c.reset}`);
    }
    console.log(`${c.dim}  Running ${STEPS.length} CI-blocking checks...${c.reset}\n`);
  }

  for (const step of STEPS) {
    if (!CI_MODE) {
      console.log(`${c.cyan}▶ ${step.name}${c.reset}`);
    }

    const result = await runStep(step);
    results.push(result);

    if (!CI_MODE) {
      if (result.passed) {
        console.log(`${c.green}✓ ${step.name}${c.reset} ${c.dim}(${formatMs(result.duration)})${c.reset}\n`);
      } else {
        console.log(`${c.red}✗ ${step.name} FAILED${c.reset} ${c.dim}(${formatMs(result.duration)})${c.reset}\n`);
      }
    }

    // Fail fast — no point continuing if data build or tests fail
    if (!result.passed) {
      break;
    }
  }

  const totalDuration = Date.now() - totalStart;
  const passed = results.every((r) => r.passed);
  const failed = results.filter((r) => !r.passed);

  if (CI_MODE) {
    console.log(JSON.stringify({ passed, results, duration: formatMs(totalDuration) }));
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

  process.exit(passed ? 0 : 1);
}

main();
