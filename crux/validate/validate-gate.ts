#!/usr/bin/env node

/**
 * Gate Validation — CI-blocking checks in one command
 *
 * Runs the same checks that CI enforces, locally, before push.
 * Used by .githooks/pre-push to mechanically block bad pushes.
 *
 * Steps (fast mode, default):
 *   0. Triage — categorize diff, optionally ask Haiku which checks to skip
 *   1. Build data layer (required for validation + tests) — skippable if only crux/ changed
 *   2. Auto-fix escaping + markdown (with --fix)
 *   3. [Parallel] Run vitest tests
 *      [Parallel] Unified blocking rules (MDX syntax, frontmatter, numeric IDs, EntityLink)
 *      [Parallel] YAML schema validation
 *      [Parallel] TypeScript type check — app
 *      [Parallel] TypeScript type check — crux
 *
 * With --full:
 *   4. Full Next.js production build
 *
 * Flags:
 *   --full-gate    Force all checks, no triage (implies --no-triage, --no-cache)
 *   --no-triage    Skip LLM triage call, run all checks
 *   --no-cache     Ignore stamp cache, force full re-run
 *   --fix          Auto-fix escaping + markdown before validation
 *   --full         Include full Next.js production build
 *   --ci           JSON output for CI pipelines (implies --no-cache)
 *   --scope=content  Content-only: skip build-data/tests/typechecks, run only
 *                    unified-blocking + yaml-schema (no stamp cache written)
 *
 * Exit codes:
 *   0 = All checks passed
 *   1 = One or more checks failed
 */

import { execSync, spawn, type ChildProcess } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';
import { categorizeFiles, canSkipBuildData, triageGateChecks, type TriageResult } from './gate-triage.ts';

const args: string[] = process.argv.slice(2);
const FIX_MODE: boolean = args.includes('--fix');
const CI_MODE: boolean = args.includes('--ci') || process.env.CI === 'true';
const FULL_GATE: boolean = args.includes('--full-gate');
const NO_TRIAGE: boolean = args.includes('--no-triage') || FULL_GATE || CI_MODE;
const NO_CACHE: boolean = args.includes('--no-cache') || FULL_GATE || CI_MODE;
const SCOPE: string = args.find(a => a.startsWith('--scope='))?.split('=')[1] || '';
const CONTENT_ONLY: boolean = SCOPE === 'content';

// ── Stamp-based caching ──────────────────────────────────────────────────────
// After a successful gate run, we write the HEAD commit hash + mode to a stamp
// file inside .git/. On subsequent runs, if HEAD hasn't changed and the mode
// is compatible, we skip the entire gate. This prevents re-running a ~5min
// check suite on repeated push attempts for the same commit.

const STAMP_FILE = join(PROJECT_ROOT, '.git', 'gate-stamp');

function getHeadHash(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
  } catch {
    // Fail-closed: empty hash means stamp cache won't match, so gate runs fully
    return '';
  }
}

function readStamp(): { hash: string; mode: string } | null {
  try {
    const content = readFileSync(STAMP_FILE, 'utf-8').trim();
    const [hash, mode] = content.split(' ');
    if (hash && mode) return { hash, mode };
    return null;
  } catch {
    // Fail-closed: no stamp means gate runs fully (no cache hit)
    return null;
  }
}

function writeStamp(hash: string, mode: string): void {
  try {
    writeFileSync(STAMP_FILE, `${hash} ${mode}\n`);
  } catch {
    // Non-fatal: stamp write failure just means next push will re-run the gate
  }
}

/**
 * Get the list of files changed on this branch vs main.
 * Reused by shouldAutoEscalateToFull() and the triage phase.
 */
function getChangedFiles(): string[] {
  try {
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
    if (!diffOutput) return [];
    return diffOutput.split('\n').filter(Boolean);
  } catch {
    // Fail-closed: empty file list means no triage optimization, all checks run
    return [];
  }
}

/**
 * Auto-detect whether --full (Next.js build) is needed based on changed files.
 * Triggers when the diff includes app page components or data files that are
 * prerendered at build time (e.g. auto-update YAML that dashboards read).
 */
function shouldAutoEscalateToFull(files: string[]): boolean {
  return files.some(f =>
    // App page components (prerendered by Next.js)
    f.startsWith('apps/web/src/app/') ||
    // Auto-update run data (read by dashboard pages at build time)
    f.startsWith('data/auto-update/runs/') ||
    // Auto-update state/sources (read by dashboard pages at build time)
    (f.startsWith('data/auto-update/') && f.endsWith('.yaml'))
  );
}

const changedFiles = getChangedFiles();
const EXPLICIT_FULL: boolean = args.includes('--full');
const AUTO_FULL: boolean = !EXPLICIT_FULL && shouldAutoEscalateToFull(changedFiles);
const FULL_MODE: boolean = EXPLICIT_FULL || AUTO_FULL;

const c = getColors(CI_MODE);

interface Step {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  advisory?: boolean; // if true, failure is reported but doesn't block
}

const APP_DIR = `${PROJECT_ROOT}/apps/web`;

// Phase 0.5: Assign IDs from wiki-server before build-data
const ASSIGN_IDS_STEP: Step = {
  id: 'assign-ids',
  name: 'Assign entity IDs from server',
  command: 'node',
  args: ['--import', 'tsx/esm', 'scripts/assign-ids.mjs'],
  cwd: APP_DIR,
  // Fail-open: ID assignment depends on the wiki-server being reachable.
  // If the server is unavailable, build-data has its own local fallback
  // (max-id-from-YAML + 1). Blocking the gate on server availability would
  // break offline development.
  advisory: true,
};

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
  'entitylink-ids',
  'footnote-integrity',
  'frontmatter-schema',
  'no-quoted-subcategory',
  'numeric-id-integrity',
  'pipeline-artifacts',
  'prefer-entitylink',
  'resource-ref-integrity',
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
    name: 'Unified blocking rules (MDX syntax, frontmatter, numeric IDs, EntityLink, pipeline artifacts)',
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
    name: 'TypeScript type check — app',
    command: 'npx',
    args: ['tsc', '--noEmit'],
    cwd: APP_DIR,
  },
  {
    id: 'typecheck-crux',
    name: 'TypeScript type check — crux (advisory)',
    command: 'npx',
    args: ['tsc', '--noEmit', '-p', '../../crux/tsconfig.json'],
    cwd: APP_DIR,
    // Fail-open: crux has its own tsconfig with relaxed settings and
    // a known baseline of pre-existing errors. Blocking on crux type
    // errors would prevent shipping app-only fixes. Use validate-crux-tsc
    // baseline check for enforcement instead.
    advisory: true,
  },
  {
    id: 'returning-guard',
    name: '.returning() guard check',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-returning-guard.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'drizzle-journal',
    name: 'Drizzle migration journal integrity',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-drizzle-journal.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'untyped-rows',
    name: 'No untyped row casts in routes',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-untyped-rows.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'no-console-log',
    name: 'No console.log in server code',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-no-console-log.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'conflict-markers',
    name: 'Conflict marker detection',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-conflict-markers.ts'],
    cwd: PROJECT_ROOT,
  },
  {
    id: 'mdx-compile',
    name: 'MDX compilation smoke-test (advisory)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-mdx-compile.ts', '--quick'],
    cwd: PROJECT_ROOT,
    // Fail-open: MDX compilation catches rendering issues that aren't
    // syntax errors. Some pages have known compilation warnings that don't
    // affect production rendering. The full Next.js build (--full mode)
    // is the authoritative compilation check.
    advisory: true,
  },
  {
    id: 'review-marker',
    name: 'PR review status (advisory)',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-review-marker.ts'],
    cwd: PROJECT_ROOT,
    // Advisory for now: warns when a large PR (>5 files or >300 lines)
    // has not been reviewed via /review-pr. Does not block the gate.
    // To make blocking: remove `advisory: true`.
    advisory: true,
  },
  {
    id: 'typecheck-crux-baseline',
    name: 'Crux TypeScript check',
    command: 'npx',
    args: ['tsx', 'crux/validate/validate-crux-tsc.ts'],
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
  advisory?: boolean;
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
        advisory: step.advisory,
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
        advisory: step.advisory,
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
  let triageResult: TriageResult | null = null;
  let skippedBuildData = false;

  // ── Stamp cache check — skip gate if HEAD unchanged since last pass ────────
  if (!NO_CACHE) {
    const headHash = getHeadHash();
    const stamp = readStamp();
    if (headHash && stamp && stamp.hash === headHash) {
      // A "full" stamp satisfies both full and fast requests.
      // A "fast" stamp only satisfies fast requests.
      const modeOk = stamp.mode === 'full' || !FULL_MODE;
      if (modeOk) {
        if (!CI_MODE) {
          console.log(`\n${c.green}${c.bold}  ✅ Gate already passed for this commit${c.reset} ${c.dim}(${headHash.slice(0, 8)}, ${stamp.mode} mode)${c.reset}`);
          console.log(`${c.dim}  Skipping re-run. Use --no-cache to force.${c.reset}\n`);
        }
        process.exit(0);
      }
    }
  }

  // ── Content-only scope — skip build pipeline, run only content validations ──
  if (CONTENT_ONLY) {
    if (!CI_MODE) {
      console.log(`\n${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
      console.log(`${c.bold}${c.blue}  Gate Check (content-only scope)${c.reset}`);
      console.log(`${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
      console.log(`${c.dim}  Skipping build-data, tests, typechecks — content validation only${c.reset}\n`);
    }

    // Phase 2: Auto-fix (if requested)
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

    // Phase 3 (subset): Only content-relevant checks
    const contentSteps = PARALLEL_STEPS.filter(s =>
      s.id === 'unified-blocking' || s.id === 'yaml-schema'
    );
    const contentResults = await runParallel(contentSteps);
    allResults.push(...contentResults);

    printSummary(allResults, totalStart);

    if (contentResults.some(r => !r.passed && !r.advisory)) {
      process.exit(1);
    }
    // Do NOT write stamp cache for content-only runs
    process.exit(0);
  }

  // ── Phase 0: Triage — decide which checks to skip ─────────────────────────
  if (!NO_TRIAGE && changedFiles.length > 0) {
    const categories = categorizeFiles(changedFiles);

    // Deterministic: skip build-data if only crux/wiki-server changes
    if (canSkipBuildData(categories)) {
      skippedBuildData = true;
    }

    // LLM triage: ask Haiku which parallel checks to skip
    const allStepIds = PARALLEL_STEPS.map(s => s.id);
    triageResult = await triageGateChecks(changedFiles, allStepIds, categories);
  }

  // Filter parallel steps based on triage
  const skippedStepIds = new Set(triageResult ? Object.keys(triageResult.skip) : []);
  const activeParallelSteps = PARALLEL_STEPS.filter(s => !skippedStepIds.has(s.id));
  const skippedCount = PARALLEL_STEPS.length - activeParallelSteps.length + (skippedBuildData ? 1 : 0);

  const totalSteps = (skippedBuildData ? 0 : 1) + (FIX_MODE ? FIX_STEPS.length : 0) + activeParallelSteps.length + (FULL_MODE ? 1 : 0);

  if (!CI_MODE) {
    const mode = FULL_MODE ? 'full' : 'fast';
    console.log(`\n${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    console.log(`${c.bold}${c.blue}  Gate Check (${mode})${c.reset}`);
    console.log(`${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
    if (AUTO_FULL) {
      console.log(`${c.dim}  Auto-escalated to full build (app pages or data files changed)${c.reset}`);
    }
    if (skippedCount > 0) {
      console.log(`${c.dim}  Triage: ${skippedCount} check${skippedCount > 1 ? 's' : ''} skipped based on diff analysis${c.reset}`);
      if (skippedBuildData) {
        console.log(`${c.dim}    - build-data: no MDX/YAML/app changes, database.json exists${c.reset}`);
      }
      if (triageResult) {
        for (const [id, reason] of Object.entries(triageResult.skip)) {
          console.log(`${c.dim}    - ${id}: ${reason}${c.reset}`);
        }
        if (triageResult.llmCalled) {
          console.log(`${c.dim}    (Haiku triage in ${triageResult.durationMs}ms)${c.reset}`);
        }
      }
    }
    console.log(`${c.dim}  Running ${totalSteps} CI-blocking checks (${activeParallelSteps.length} in parallel)...${c.reset}\n`);
  }

  // ── Phase 0.5: Assign IDs from server (advisory — doesn't block) ───────────
  if (skippedBuildData) {
    if (!CI_MODE) {
      console.log(`${c.dim}⊘ Assign entity IDs (skipped — no data changes)${c.reset}`);
    }
  } else {
    const assignIdsResult = await runSequential(ASSIGN_IDS_STEP);
    allResults.push(assignIdsResult);
    // Advisory: log failure but don't exit — build-data has its own fallback
    if (!assignIdsResult.passed && !CI_MODE) {
      console.log(`${c.yellow}  ⚠ ID assignment failed (server may be unavailable) — build-data will use fallback${c.reset}\n`);
    }
  }

  // ── Phase 1: Build data (prerequisite for everything) ──────────────────────
  if (skippedBuildData) {
    if (!CI_MODE) {
      console.log(`${c.dim}⊘ Build data layer (skipped — no data changes)${c.reset}\n`);
    }
  } else {
    const buildDataResult = await runSequential(BUILD_DATA_STEP);
    allResults.push(buildDataResult);
    if (!buildDataResult.passed) {
      printSummary(allResults, totalStart, skippedCount);
      process.exit(1);
    }
  }

  // ── Phase 2: Auto-fix (sequential, must run before validation) ─────────────
  if (FIX_MODE) {
    for (const step of FIX_STEPS) {
      const result = await runSequential(step);
      allResults.push(result);
      if (!result.passed) {
        printSummary(allResults, totalStart, skippedCount);
        process.exit(1);
      }
    }
  }

  // ── Phase 3: Independent checks in parallel ────────────────────────────────
  const parallelResults = await runParallel(activeParallelSteps);
  allResults.push(...parallelResults);
  if (parallelResults.some(r => !r.passed && !r.advisory)) {
    printSummary(allResults, totalStart, skippedCount);
    process.exit(1);
  }

  // ── Phase 4: Full Next.js build (only if all other checks pass) ────────────
  if (FULL_MODE) {
    const buildResult = await runSequential(BUILD_STEP);
    allResults.push(buildResult);
    if (!buildResult.passed) {
      printSummary(allResults, totalStart, skippedCount);
      process.exit(1);
    }
  }

  printSummary(allResults, totalStart, skippedCount);

  // Write stamp so subsequent pushes of the same commit skip the gate
  const headHash = getHeadHash();
  if (headHash) {
    writeStamp(headHash, FULL_MODE ? 'full' : 'fast');
  }

  process.exit(0);
}

function printSummary(results: StepResult[], totalStart: number, skippedCount: number = 0): void {
  const totalDuration = Date.now() - totalStart;
  const blockingFailed = results.filter((r) => !r.passed && !r.advisory);
  const advisoryFailed = results.filter((r) => !r.passed && r.advisory);
  const passed = blockingFailed.length === 0;
  const failed = blockingFailed;

  if (CI_MODE) {
    console.log(JSON.stringify({ passed, skippedCount, results: results.map(r => ({ id: r.id, name: r.name, passed: r.passed, duration: r.duration, exitCode: r.exitCode })), duration: formatMs(totalDuration) }));
  } else {
    console.log(`${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    if (passed) {
      const skippedNote = skippedCount > 0 ? `, ${skippedCount} skipped by triage` : '';
      const advisoryNote = advisoryFailed.length > 0
        ? ` ${c.dim}(${advisoryFailed.length} advisory warning${advisoryFailed.length > 1 ? 's' : ''}${skippedNote})${c.reset}`
        : (skippedNote ? ` ${c.dim}(${skippedNote.slice(2)})${c.reset}` : '');
      console.log(`${c.green}${c.bold}  ✅ All ${results.length} gate checks passed${c.reset} ${c.dim}(${formatMs(totalDuration)})${c.reset}${advisoryNote}`);
      for (const f of advisoryFailed) {
        console.log(`${c.yellow}  ⚠ ${f.name}${c.reset}`);
      }
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