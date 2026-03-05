/**
 * PR Patrol — Continuous PR maintenance daemon
 *
 * Scans open PRs for issues (conflicts, CI failures, missing test plans,
 * missing issue refs, staleness), scores them by priority, and spawns
 * `claude` CLI to fix the highest-priority one per cycle.
 *
 * TypeScript rewrite of scripts/pr-patrol.sh.
 */

import { spawn } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { githubApi, githubGraphQL, REPO } from '../lib/github.ts';
import { gitSafe } from '../lib/git.ts';
import { parseIntOpt } from '../lib/cli.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type PrIssueType =
  | 'conflict'
  | 'ci-failure'
  | 'missing-testplan'
  | 'missing-issue-ref'
  | 'stale';

interface DetectedPr {
  number: number;
  title: string;
  branch: string;
  createdAt: string;
  issues: PrIssueType[];
}

interface ScoredPr extends DetectedPr {
  score: number;
}

type FixOutcome = 'fixed' | 'max-turns' | 'timeout' | 'error' | 'dry-run';

// ── Config ───────────────────────────────────────────────────────────────────

export interface PatrolConfig {
  repo: string;
  intervalSeconds: number;
  maxTurns: number;
  cooldownSeconds: number;
  staleHours: number;
  model: string;
  skipPerms: boolean;
  once: boolean;
  dryRun: boolean;
  verbose: boolean;
  reflectionInterval: number;
  timeoutMinutes: number;
}

const STATE_DIR = '/tmp/pr-patrol-shared';
const CACHE_DIR = join(process.env.HOME ?? '/tmp', '.cache', 'pr-patrol');
const JSONL_FILE = join(CACHE_DIR, 'runs.jsonl');
const REFLECTION_FILE = join(CACHE_DIR, 'reflections.jsonl');

export function buildConfig(
  _args: string[],
  options: Record<string, unknown>,
): PatrolConfig {
  // Note: crux.mjs converts kebab-case flags to camelCase (--dry-run → dryRun)
  return {
    repo: (process.env.PR_PATROL_REPO as string) ?? REPO,
    intervalSeconds: parseIntOpt(
      options.interval ?? process.env.PR_PATROL_INTERVAL,
      300,
    ),
    maxTurns: parseIntOpt(
      options.maxTurns ?? process.env.PR_PATROL_MAX_TURNS,
      40,
    ),
    cooldownSeconds: parseIntOpt(
      options.cooldown ?? process.env.PR_PATROL_COOLDOWN,
      1800,
    ),
    staleHours: parseIntOpt(process.env.PR_PATROL_STALE_HOURS, 48),
    model:
      (options.model as string) ??
      process.env.PR_PATROL_MODEL ??
      'sonnet',
    skipPerms:
      options.skipPerms === true ||
      process.env.PR_PATROL_SKIP_PERMS === '1',
    once: options.once === true,
    dryRun: options.dryRun === true,
    verbose: options.verbose === true,
    reflectionInterval: Math.max(
      1,
      parseIntOpt(process.env.PR_PATROL_REFLECTION_INTERVAL, 10),
    ),
    timeoutMinutes: parseIntOpt(
      options.timeout ?? process.env.PR_PATROL_TIMEOUT_MINUTES,
      30,
    ),
  };
}

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(line);
}

function logHeader(msg: string): void {
  console.error('');
  log('═'.repeat(55));
  log(msg);
  log('═'.repeat(55));
}

function appendJsonl(file: string, entry: Record<string, unknown>): void {
  appendFileSync(
    file,
    JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n',
  );
}

// ── Cooldown tracking ────────────────────────────────────────────────────────

function isRecentlyProcessed(pr: number, cooldownSeconds: number): boolean {
  const file = join(STATE_DIR, `processed-${pr}`);
  if (!existsSync(file)) return false;
  const last = Number(readFileSync(file, 'utf-8').trim());
  return Date.now() / 1000 - last < cooldownSeconds;
}

function markProcessed(pr: number): void {
  writeFileSync(
    join(STATE_DIR, `processed-${pr}`),
    String(Math.floor(Date.now() / 1000)),
  );
}

function getMaxTurnsFailCount(pr: number): number {
  const file = join(STATE_DIR, `max-turns-${pr}`);
  if (!existsSync(file)) return 0;
  return parseInt(readFileSync(file, 'utf-8').trim(), 10) || 0;
}

function recordMaxTurnsFailure(pr: number): number {
  const count = getMaxTurnsFailCount(pr) + 1;
  writeFileSync(join(STATE_DIR, `max-turns-${pr}`), String(count));
  return count;
}

function isAbandoned(pr: number): boolean {
  return getMaxTurnsFailCount(pr) >= 2;
}

// ── PR Detection (GraphQL) ──────────────────────────────────────────────────

const PR_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title headRefName mergeable createdAt updatedAt body
        labels(first: 20) { nodes { name } }
        commits(last: 1) { nodes { commit { statusCheckRollup {
          contexts(first: 50) { nodes {
            ... on CheckRun { conclusion }
            ... on StatusContext { state }
          }}
        }}}}
      }
    }
  }
}`;

interface GqlPrNode {
  number: number;
  title: string;
  headRefName: string;
  mergeable: string;
  createdAt: string;
  updatedAt: string;
  body: string | null;
  labels: { nodes: Array<{ name: string }> };
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          contexts: {
            nodes: Array<{ conclusion?: string | null; state?: string }>;
          };
        } | null;
      };
    }>;
  };
}

/** Pure function — detects issues on a single PR node. */
export function detectIssues(
  pr: GqlPrNode,
  staleThresholdMs: number,
): PrIssueType[] {
  const issues: PrIssueType[] = [];

  if (pr.mergeable === 'CONFLICTING') issues.push('conflict');

  const contexts =
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  // CheckRun nodes use `conclusion`, StatusContext nodes use `state`
  if (
    contexts.some(
      (c) =>
        c.conclusion === 'FAILURE' ||
        c.state === 'FAILURE' ||
        c.state === 'ERROR',
    )
  ) {
    issues.push('ci-failure');
  }

  const body = pr.body ?? '';
  if (!/## Test [Pp]lan/.test(body)) issues.push('missing-testplan');
  if (!/(Closes|Fixes|Resolves) #\d/.test(body)) issues.push('missing-issue-ref');

  const updatedMs = new Date(pr.updatedAt || pr.createdAt).getTime();
  if (updatedMs < staleThresholdMs) issues.push('stale');

  return issues;
}

async function detectAllPrIssues(config: PatrolConfig): Promise<DetectedPr[]> {
  const [owner, name] = config.repo.split('/');
  const data = await githubGraphQL<{
    repository: { pullRequests: { nodes: GqlPrNode[] } };
  }>(PR_QUERY, { owner, name });

  const prs = data.repository.pullRequests.nodes;
  const staleThresholdMs = Date.now() - config.staleHours * 3600 * 1000;

  log(`Found ${prs.length} open PRs`);

  return prs
    .filter((pr) => {
      const labels = pr.labels.nodes.map((l) => l.name);
      if (labels.includes('claude-working')) return false;
      return true;
    })
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      createdAt: pr.createdAt,
      issues: detectIssues(pr, staleThresholdMs),
    }))
    .filter((pr) => pr.issues.length > 0);
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const ISSUE_SCORES: Record<PrIssueType, number> = {
  conflict: 100,
  'ci-failure': 80,
  'missing-issue-ref': 40,
  stale: 30,
  'missing-testplan': 20,
};

/** Pure function — computes priority score for a detected PR. */
export function computeScore(pr: DetectedPr): number {
  let score = 0;
  for (const issue of pr.issues) score += ISSUE_SCORES[issue] ?? 0;

  // Age bonus: 1 point per hour, capped at 50
  const ageHours = (Date.now() - new Date(pr.createdAt).getTime()) / 3_600_000;
  score += Math.min(50, Math.max(0, Math.floor(ageHours)));

  return score;
}

function rankPrs(prs: DetectedPr[]): ScoredPr[] {
  return prs
    .map((pr) => ({ ...pr, score: computeScore(pr) }))
    .sort((a, b) => b.score - a.score);
}

// ── Prompt builder ──────────────────────────────────────────────────────────

function buildPrompt(pr: DetectedPr, repo: string): string {
  const { number: num, title, branch, issues } = pr;
  const sections: string[] = [];

  sections.push(`You are a PR maintenance agent for the ${repo} repository.

## Target
PR #${num}: "${title}" (branch: ${branch})

## Issues Detected
${issues.join(', ')}

## Instructions

1. First, fetch PR details to understand context:
   gh pr view ${num} --repo ${repo} --json headRefName,body,statusCheckRollup,reviews

2. Check out the PR branch:
   git fetch origin ${branch}
   git checkout ${branch}

3. Fix each detected issue:`);

  if (issues.includes('conflict')) {
    sections.push(`
### Merge Conflict
- Rebase onto main: git rebase origin/main
- Resolve any conflicts (prefer keeping PR changes where intent is clear)
- If conflicts are in generated files (database.json, lock files), regenerate them
- After resolving: git rebase --continue, then git push --force-with-lease`);
  }

  if (issues.includes('ci-failure')) {
    sections.push(`
### CI Failure
- Check CI status: gh pr checks ${num} --repo ${repo}
- Read the failing check logs to understand the failure
- Fix the issue (build error, test failure, lint error)
- Run locally to verify: pnpm build and/or pnpm test
- Commit and push the fix`);
  }

  if (issues.includes('missing-testplan')) {
    sections.push(`
### Missing Test Plan
- Read the PR diff to understand what changed
- Update the PR body to add a "## Test plan" section with relevant verification steps
- Use gh pr edit to update the body`);
  }

  if (issues.includes('missing-issue-ref')) {
    sections.push(`
### Missing Issue Reference
- Search for related issues: gh issue list --search "keywords from PR title" --repo ${repo}
- If a matching issue exists, add "Closes #N" to the PR body
- If no matching issue exists, this may be fine — skip this fix`);
  }

  sections.push(`
## Guardrails
- Only fix the detected issues — do not refactor or improve unrelated code
- If a conflict is too complex to resolve confidently, skip it and note why
- After any code changes, run: pnpm crux validate gate --fix
- Use git push --force-with-lease (never --force) when pushing rebased branches
- Do not modify files unrelated to the fix
- Do NOT run /agent-session-start or /agent-session-ready-PR — this is a targeted fix, not a full session
- Do NOT create new branches — work on the existing PR branch`);

  return sections.join('\n');
}

// ── Fix execution ───────────────────────────────────────────────────────────

let claimedPr: number | null = null;

async function claimPr(prNum: number, repo: string): Promise<void> {
  try {
    await githubApi(`/repos/${repo}/issues/${prNum}/labels`, {
      method: 'POST',
      body: { labels: ['claude-working'] },
    });
    claimedPr = prNum;
  } catch {
    log(`  Warning: could not add claude-working label to PR #${prNum}`);
  }
}

async function releasePr(prNum: number, repo: string): Promise<void> {
  try {
    await githubApi(`/repos/${repo}/issues/${prNum}/labels/claude-working`, {
      method: 'DELETE',
    });
  } catch {
    // Label may not exist — that's fine
  }
  if (claimedPr === prNum) claimedPr = null;
}

async function releaseCurrentClaim(repo: string): Promise<void> {
  if (claimedPr !== null) {
    await releasePr(claimedPr, repo).catch(() => {});
  }
}

function spawnClaude(
  prompt: string,
  config: PatrolConfig,
): Promise<{ exitCode: number; output: string; hitMaxTurns: boolean; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--model',
      config.model,
      '--max-turns',
      String(config.maxTurns),
      '--verbose',
    ];
    if (config.skipPerms) args.push('--dangerously-skip-permissions');

    // Unset CLAUDECODE to prevent subprocess hang inside Claude Code sessions
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn('claude', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;

    // Hard timeout — kill subprocess if it runs too long
    const timeoutMs = config.timeoutMinutes * 60 * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`  ⚠ Claude subprocess timed out after ${config.timeoutMinutes}m — killing`);
      child.kill('SIGTERM');
      // Force kill if SIGTERM doesn't work within 10s
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 10_000);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.stdin.write(prompt);
    child.stdin.end();

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        output,
        hitMaxTurns: output.includes('Reached max turns'),
        timedOut,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function fixPr(pr: ScoredPr, config: PatrolConfig): Promise<void> {
  log(`→ Fixing PR #${pr.number} (${pr.title})`);
  log(`  Issues: ${pr.issues.join(', ')}`);
  log(`  Branch: ${pr.branch}`);

  if (config.dryRun) {
    log('  [DRY RUN] Would invoke Claude to fix');
    appendJsonl(JSONL_FILE, {
      type: 'pr_result',
      pr_num: pr.number,
      issues: pr.issues,
      outcome: 'dry-run' as FixOutcome,
      elapsed_s: 0,
    });
    markProcessed(pr.number);
    return;
  }

  // Save current branch to restore after fix
  const origBranch = gitSafe('branch', '--show-current');
  const originalBranch = origBranch.ok ? origBranch.output.trim() : '';

  await claimPr(pr.number, config.repo);

  const prompt = buildPrompt(pr, config.repo);
  const startTime = Date.now();

  let outcome: FixOutcome = 'fixed';
  let reason = '';

  try {
    const result = await spawnClaude(prompt, config);
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);

    if (result.timedOut) {
      outcome = 'timeout';
      reason = `Killed after ${config.timeoutMinutes}m timeout`;
      log(`✗ PR #${pr.number} timed out after ${config.timeoutMinutes}m`);
    } else if (result.exitCode === 0 && !result.hitMaxTurns) {
      log(`✓ PR #${pr.number} processed successfully (${elapsedS}s)`);
      outcome = 'fixed';

      // Post summary comment
      const summary = result.output.slice(-500);
      if (summary) {
        await githubApi(`/repos/${config.repo}/issues/${pr.number}/comments`, {
          method: 'POST',
          body: {
            body: `🤖 **PR Patrol** ran for ${elapsedS}s (${config.maxTurns} max turns, model: ${config.model}).\n\n**Issues detected**: ${pr.issues.join(', ')}\n\n**Result**:\n${summary}`,
          },
        }).catch(() => log('  Warning: could not post summary comment'));
      }
    } else if (result.hitMaxTurns) {
      const failCount = recordMaxTurnsFailure(pr.number);
      outcome = 'max-turns';
      reason = `Hit max turns (${config.maxTurns}) — attempt ${failCount}`;
      log(`⚠ PR #${pr.number} hit max turns after ${elapsedS}s`);

      if (failCount >= 2) {
        reason = `Abandoned after ${failCount} max-turns failures`;
        log(
          `✗ PR #${pr.number} abandoned after ${failCount} max-turns failures`,
        );
        await githubApi(
          `/repos/${config.repo}/issues/${pr.number}/comments`,
          {
            method: 'POST',
            body: {
              body: `🤖 **PR Patrol**: Abandoning automatic fix after ${failCount} failed attempts (hit max turns each time).\n\n**Issues detected**: ${pr.issues.join(', ')}\n**Last attempt**: ${elapsedS}s, ${config.maxTurns} turns\n\nThis PR likely needs human intervention to resolve.`,
            },
          },
        ).catch(() => log('  Warning: could not post abandonment comment'));
      }
    } else {
      outcome = 'error';
      reason = `Exit code: ${result.exitCode}`;
      log(
        `✗ PR #${pr.number} processing failed (exit: ${result.exitCode}, ${elapsedS}s)`,
      );
    }

    appendJsonl(JSONL_FILE, {
      type: 'pr_result',
      pr_num: pr.number,
      issues: pr.issues,
      outcome,
      elapsed_s: elapsedS,
      reason: reason || undefined,
    });
  } finally {
    await releasePr(pr.number, config.repo);

    // Clean up any in-progress rebase/merge left by the spawned session
    gitSafe('rebase', '--abort');
    gitSafe('merge', '--abort');

    // Restore original branch
    if (originalBranch) {
      gitSafe('checkout', originalBranch);
    }

    markProcessed(pr.number);
  }
}

// ── Reflection ──────────────────────────────────────────────────────────────

async function runReflection(
  cycleCount: number,
  config: PatrolConfig,
): Promise<void> {
  logHeader(`Reflection (cycle #${cycleCount})`);

  if (!existsSync(JSONL_FILE)) {
    log('Skipping reflection — no log file yet');
    return;
  }

  const allEntries = readFileSync(JSONL_FILE, 'utf-8').trim().split('\n');
  if (allEntries.length < 10) {
    log(`Skipping reflection — only ${allEntries.length} log entries (need ≥10)`);
    return;
  }

  const recentEntries = allEntries.slice(-100).join('\n');

  const prompt = `You are a PR Patrol operations analyst for the ${config.repo} repository.
Your job is to review recent automated PR fix logs and identify actionable patterns that warrant filing a GitHub issue.

## Recent JSONL Log Entries

${recentEntries}

## Your Task

1. Analyze the logs for patterns:
   - PRs that repeatedly hit max-turns or error out (wasted compute)
   - Issue types that are never successfully fixed
   - PRs being re-processed for the same unfixable issues
   - High elapsed times suggesting the prompt needs improvement

2. If you find something actionable:
   a. First, search for an existing issue: pnpm crux issues search "your topic"
   b. If no duplicate exists, file exactly ONE issue:
      pnpm crux issues create "Title" --problem="Specific description with data from logs" --model=haiku --criteria="Fix applied|Tests pass" --label=pr-patrol
   c. If a duplicate exists, add a comment with your new data: pnpm crux issues comment <N> "new evidence"

3. If nothing actionable is found, just output: "No actionable patterns found"

## Constraints
- File AT MOST 1 issue.
- Issues must reference concrete data from the logs (PR numbers, counts, cycle numbers).
- Do NOT file speculative issues — only patterns demonstrated by log data.
- Do NOT file issues about one-time events — look for recurring patterns (3+ occurrences).
- Do NOT run any git commands or modify any files.
- Do NOT run /agent-session-start or /agent-session-ready-PR.`;

  const startTime = Date.now();
  try {
    const result = await spawnClaude(prompt, {
      ...config,
      maxTurns: 10, // Reflection needs fewer turns
    });
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);
    const filedIssue = /Created issue #|created.*#\d/.test(result.output);

    appendJsonl(REFLECTION_FILE, {
      cycle_number: cycleCount,
      elapsed_s: elapsedS,
      filed_issue: filedIssue,
      exit_code: result.exitCode,
      summary: result.output.slice(-500),
    });

    log(
      `✓ Reflection complete (${elapsedS}s, filed_issue=${filedIssue})`,
    );
  } catch (e) {
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);
    log(
      `✗ Reflection failed (${elapsedS}s): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ── Daemon loop ─────────────────────────────────────────────────────────────

function preflightChecks(config: PatrolConfig): string[] {
  const errors: string[] = [];
  const inRepo = gitSafe('rev-parse', '--is-inside-work-tree');
  if (!inRepo.ok) errors.push('Must run inside a git worktree');

  // Only enforce clean tree when actually fixing (not for dry-run or status)
  if (!config.dryRun) {
    // Use git status --porcelain to catch both modified and untracked files
    // that could interfere with branch switching during fixes.
    // Filter out known noise directories that are always untracked.
    const IGNORED_PREFIXES = ['.claude/worktrees/', '.claude/wip-'];
    const status = gitSafe('status', '--porcelain');
    if (status.ok && status.output.trim()) {
      const significant = status.output
        .trim()
        .split('\n')
        .filter((line) => {
          const filePath = line.slice(3); // strip status prefix "?? " / " M " etc.
          return !IGNORED_PREFIXES.some((p) => filePath.startsWith(p));
        });
      if (significant.length > 0) {
        errors.push(
          'Working tree must be clean before starting PR Patrol. Commit or stash your changes first.\n' +
            `  Dirty files: ${significant.slice(0, 5).map((l) => l.trim()).join(', ')}${significant.length > 5 ? ` (+${significant.length - 5} more)` : ''}`,
        );
      }
    }
  }

  if (!process.env.GITHUB_TOKEN) {
    errors.push('GITHUB_TOKEN not set');
  }

  return errors;
}

async function runCheckCycle(
  cycleCount: number,
  config: PatrolConfig,
): Promise<void> {
  logHeader(`Check cycle #${cycleCount}`);

  // 1. Detect issues
  const detected = await detectAllPrIssues(config);
  if (detected.length === 0) {
    log('All PRs clean — nothing to do');
    appendJsonl(JSONL_FILE, {
      type: 'cycle_summary',
      cycle_number: cycleCount,
      prs_scanned: 0,
      queue_size: 0,
      pr_processed: null,
    });
    return;
  }

  // 2. Filter cooldowns and abandoned
  const eligible = detected.filter((pr) => {
    if (isAbandoned(pr.number)) {
      log(`  Skipping PR #${pr.number} (abandoned — needs human intervention)`);
      return false;
    }
    if (isRecentlyProcessed(pr.number, config.cooldownSeconds)) {
      log(`  Skipping PR #${pr.number} (recently processed)`);
      return false;
    }
    return true;
  });

  // 3. Score and sort
  const ranked = rankPrs(eligible);
  if (ranked.length === 0) {
    log('All issues recently processed — nothing to do');
    appendJsonl(JSONL_FILE, {
      type: 'cycle_summary',
      cycle_number: cycleCount,
      prs_scanned: detected.length,
      queue_size: 0,
      pr_processed: null,
    });
    return;
  }

  // 4. Display queue
  log('');
  log(`Priority queue (${ranked.length} items):`);
  for (const pr of ranked) {
    log(
      `  [score=${pr.score}] PR #${pr.number}: ${pr.issues.join(',')} — ${pr.title}`,
    );
  }
  log('');

  // 5. Process highest priority
  const top = ranked[0];
  await fixPr(top, config);

  appendJsonl(JSONL_FILE, {
    type: 'cycle_summary',
    cycle_number: cycleCount,
    prs_scanned: detected.length,
    queue_size: ranked.length,
    pr_processed: top.number,
  });
}

export async function runDaemon(config: PatrolConfig): Promise<void> {
  const errors = preflightChecks(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(`ERROR: ${e}`);
    process.exit(1);
  }

  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  logHeader('PR Patrol starting');
  log(
    `Config: interval=${config.intervalSeconds}s, max-turns=${config.maxTurns}, cooldown=${config.cooldownSeconds}s, model=${config.model}`,
  );
  log(`Repo: ${config.repo}`);
  log(`JSONL: ${JSONL_FILE}`);
  log(
    `Mode: ${config.once ? 'single pass' : config.dryRun ? 'dry run' : 'continuous'}`,
  );

  // Signal handlers for graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down...');
    await releaseCurrentClaim(config.repo);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (config.once) {
    await runCheckCycle(1, config);
    return;
  }

  let cycleCount = 0;
  while (!shuttingDown) {
    cycleCount++;
    try {
      await runCheckCycle(cycleCount, config);
    } catch (e) {
      log(
        `Check cycle failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // Periodic reflection
    if (cycleCount % config.reflectionInterval === 0) {
      try {
        await runReflection(cycleCount, config);
      } catch {
        log('Reflection failed — continuing');
      }
    }

    log(`Sleeping ${config.intervalSeconds}s until next check...`);
    await new Promise((r) => setTimeout(r, config.intervalSeconds * 1000));
  }
}

// ── Status command ──────────────────────────────────────────────────────────

export function readRecentLogs(count: number): string {
  if (!existsSync(JSONL_FILE)) return 'No PR Patrol logs found.\n';

  const lines = readFileSync(JSONL_FILE, 'utf-8').trim().split('\n');
  const recent = lines.slice(-count);
  const output: string[] = ['Recent PR Patrol activity:\n'];

  for (const line of recent) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'pr_result') {
        output.push(
          `  PR #${entry.pr_num}: ${entry.outcome} (${entry.elapsed_s}s) — ${entry.issues?.join(', ') ?? ''}`,
        );
      } else if (entry.type === 'cycle_summary') {
        output.push(
          `  Cycle #${entry.cycle_number}: scanned=${entry.prs_scanned}, queue=${entry.queue_size}, processed=${entry.pr_processed ?? 'none'}`,
        );
      }
    } catch {
      // Skip malformed lines
    }
  }

  return output.join('\n') + '\n';
}
