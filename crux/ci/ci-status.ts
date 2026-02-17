#!/usr/bin/env node

/**
 * CI Status — Check GitHub CI check-run status for the current commit.
 *
 * Usage:
 *   crux ci status              Show current check-run status
 *   crux ci status --wait       Poll every 30s until all checks complete
 *   crux ci status --sha=abc    Check a specific commit SHA
 *
 * Requires GITHUB_TOKEN environment variable.
 */

import { execSync } from 'child_process';
import { getColors } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';

const args: string[] = process.argv.slice(2);
const WAIT_MODE: boolean = args.includes('--wait');
const CI_MODE: boolean = args.includes('--ci') || process.env.CI === 'true';
const SHA_ARG = args.find((a) => a.startsWith('--sha='))?.split('=')[1];
const POLL_INTERVAL = 30_000; // 30 seconds
const MAX_POLLS = 40; // 20 minutes max

const c = getColors(CI_MODE);

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

interface CheckRunsResponse {
  total_count: number;
  check_runs: Array<{
    name: string;
    status: string;
    conclusion: string | null;
  }>;
}

function getSha(): string {
  if (SHA_ARG) return SHA_ARG;
  return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
}

async function fetchCheckRuns(sha: string): Promise<CheckRunsResponse> {
  return githubApi<CheckRunsResponse>(`/repos/${REPO}/commits/${sha}/check-runs`);
}

function formatConclusion(conclusion: string | null, status: string): string {
  if (status !== 'completed') return `${c.yellow}${status}${c.reset}`;
  if (conclusion === 'success') return `${c.green}success${c.reset}`;
  if (conclusion === 'failure') return `${c.red}failure${c.reset}`;
  if (conclusion === 'skipped') return `${c.dim}skipped${c.reset}`;
  return `${c.yellow}${conclusion || 'unknown'}${c.reset}`;
}

function printStatus(data: CheckRunsResponse, sha: string): { allDone: boolean; anyFailed: boolean } {
  let allDone = true;
  let anyFailed = false;

  if (!CI_MODE) {
    console.log(`\n${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    console.log(`${c.bold}  CI Status${c.reset} ${c.dim}(${sha.slice(0, 8)})${c.reset}`);
    console.log(`${c.bold}${c.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
  }

  if (data.total_count === 0) {
    console.log(`${c.yellow}  No checks found yet${c.reset}`);
    return { allDone: false, anyFailed: false };
  }

  for (const run of data.check_runs) {
    const formatted = formatConclusion(run.conclusion, run.status);
    if (!CI_MODE) {
      console.log(`  ${run.name.padEnd(40)} ${formatted}`);
    }
    if (run.status !== 'completed') allDone = false;
    if (run.conclusion === 'failure') anyFailed = true;
  }

  if (!CI_MODE) {
    console.log(`\n  ${c.dim}Total: ${data.total_count} checks${c.reset}`);
    if (allDone && !anyFailed) {
      console.log(`\n${c.green}${c.bold}  All checks passed${c.reset}`);
    } else if (allDone && anyFailed) {
      console.log(`\n${c.red}${c.bold}  Some checks failed${c.reset}`);
    } else {
      console.log(`\n${c.yellow}  Checks still running...${c.reset}`);
    }
    console.log('');
  }

  if (CI_MODE) {
    console.log(
      JSON.stringify({
        sha,
        total: data.total_count,
        allDone,
        anyFailed,
        checks: data.check_runs.map((r) => ({
          name: r.name,
          status: r.status,
          conclusion: r.conclusion,
        })),
      }),
    );
  }

  return { allDone, anyFailed };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const sha = getSha();

  if (!WAIT_MODE) {
    const data = await fetchCheckRuns(sha);
    const { anyFailed } = printStatus(data, sha);
    process.exit(anyFailed ? 1 : 0);
  }

  // Wait mode — poll until all checks complete
  if (!CI_MODE) {
    console.log(`${c.dim}Polling CI status every 30s (max ${MAX_POLLS} polls)...${c.reset}`);
  }

  for (let i = 0; i < MAX_POLLS; i++) {
    if (i > 0) {
      if (!CI_MODE) {
        console.log(`${c.dim}  Waiting 30s before next poll...${c.reset}\n`);
      }
      await sleep(POLL_INTERVAL);
    }

    const data = await fetchCheckRuns(sha);
    const { allDone, anyFailed } = printStatus(data, sha);

    if (allDone) {
      process.exit(anyFailed ? 1 : 0);
    }
  }

  console.error(`${c.red}Timed out waiting for CI checks to complete${c.reset}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`${c.red}Error: ${err.message}${c.reset}`);
  process.exit(1);
});
