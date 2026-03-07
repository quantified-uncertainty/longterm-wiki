/**
 * PR Patrol — Continuous PR maintenance daemon
 *
 * Scans open PRs for issues (conflicts, CI failures, missing test plans,
 * missing issue refs, staleness), scores them by priority, and spawns
 * `claude` CLI to fix the highest-priority one per cycle.
 *
 * Canonical implementation (replaces the former scripts/pr-patrol.sh).
 */

import { spawn } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { githubApi, githubGraphQL, REPO } from '../lib/github.ts';
import { gitSafe } from '../lib/git.ts';
import { parseIntOpt } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import {
  buildAbandonmentComment,
  buildFixAttemptComment,
  buildFixCompleteComment,
  buildMergeComment,
  buildMergeFailedComment,
  buildNoOpComment,
  buildStatusCommentBody,
  buildTimeoutComment,
  postEventComment,
  upsertStatusComment,
} from './comments.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type PrIssueType =
  | 'conflict'
  | 'ci-failure'
  | 'missing-testplan'
  | 'missing-issue-ref'
  | 'stale'
  | 'bot-review-major'
  | 'bot-review-nitpick';

interface BotComment {
  path: string;
  line: number | null;
  startLine: number | null;
  body: string;
  author: string;
}

interface DetectedPr {
  number: number;
  title: string;
  branch: string;
  createdAt: string;
  issues: PrIssueType[];
  botComments: BotComment[];
}

interface ScoredPr extends DetectedPr {
  score: number;
}

export type FixOutcome = 'fixed' | 'no-op' | 'max-turns' | 'timeout' | 'error' | 'dry-run';

export type MergeOutcome = 'merged' | 'dry-run' | 'error';

/** Reason a PR with ready-to-merge label is NOT eligible for merge. */
export type MergeBlockReason =
  | 'not-mergeable'
  | 'ci-failing'
  | 'ci-pending'
  | 'unresolved-threads'
  | 'unchecked-items'
  | 'claude-working'
  | 'is-draft';

export interface MergeCandidate {
  number: number;
  title: string;
  branch: string;
  createdAt: string;
  eligible: boolean;
  blockReasons: MergeBlockReason[];
}

const READY_TO_MERGE_LABEL = 'ready-to-merge';

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
export const JSONL_FILE = join(CACHE_DIR, 'runs.jsonl');
export const REFLECTION_FILE = join(CACHE_DIR, 'reflections.jsonl');

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

const cl = getColors();

function formatLocalTime(): string {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function log(msg: string): void {
  console.error(`${cl.dim}${formatLocalTime()}${cl.reset} ${msg}`);
}

function logHeader(msg: string): void {
  const t = formatLocalTime();
  console.error('');
  console.error(`${cl.dim}${t}${cl.reset} ${cl.cyan}${'─'.repeat(50)}${cl.reset}`);
  console.error(`${cl.dim}${t}${cl.reset} ${cl.bold}${msg}${cl.reset}`);
  console.error(`${cl.dim}${t}${cl.reset} ${cl.cyan}${'─'.repeat(50)}${cl.reset}`);
}

function appendJsonl(file: string, entry: Record<string, unknown>): void {
  appendFileSync(
    file,
    JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n',
  );
}

// ── Cooldown tracking ────────────────────────────────────────────────────────

function isRecentlyProcessed(key: number | string, cooldownSeconds: number): boolean {
  const file = join(STATE_DIR, `processed-${key}`);
  if (!existsSync(file)) return false;
  const last = Number(readFileSync(file, 'utf-8').trim());
  return Date.now() / 1000 - last < cooldownSeconds;
}

function markProcessed(key: number | string): void {
  writeFileSync(
    join(STATE_DIR, `processed-${key}`),
    String(Math.floor(Date.now() / 1000)),
  );
}

function getFailCount(key: number | string): number {
  // Check both new and legacy file names for backwards compat
  const newFile = join(STATE_DIR, `failures-${key}`);
  const legacyFile = join(STATE_DIR, `max-turns-${key}`);
  if (existsSync(newFile)) {
    return parseInt(readFileSync(newFile, 'utf-8').trim(), 10) || 0;
  }
  if (existsSync(legacyFile)) {
    return parseInt(readFileSync(legacyFile, 'utf-8').trim(), 10) || 0;
  }
  return 0;
}

function recordFailure(key: number | string): number {
  const count = getFailCount(key) + 1;
  writeFileSync(join(STATE_DIR, `failures-${key}`), String(count));
  return count;
}

function resetFailCount(key: number | string): void {
  const file = join(STATE_DIR, `failures-${key}`);
  if (existsSync(file)) writeFileSync(file, '0');
}

/**
 * Detect when Claude exited cleanly but didn't actually fix anything
 * (e.g., followed "stop early" guidance for human-required issues).
 */
const NO_OP_PATTERNS = [
  /no action needed/i,
  /no code changes? needed/i,
  /requires? human intervention/i,
  /needs? human/i,
  /cannot be fixed automatically/i,
  /pre-existing.*(failure|issue|problem)/i,
  /also failing on main/i,
  /stopping early/i,
  /nothing to fix/i,
];

export function looksLikeNoOp(output: string): boolean {
  // Only check the last portion of output (where the conclusion lives)
  const tail = output.slice(-1000);
  return NO_OP_PATTERNS.some((p) => p.test(tail));
}

function isAbandoned(key: number | string): boolean {
  return getFailCount(key) >= 2;
}

// ── Main Branch CI Check ────────────────────────────────────────────────────

interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  head_sha: string;
  html_url: string;
}

interface WorkflowRunsResponse {
  workflow_runs: WorkflowRun[];
  total_count: number;
}

interface MainBranchStatus {
  isRed: boolean;
  runId: number | null;
  sha: string;
  htmlUrl: string;
}

const CI_WORKFLOW = 'ci.yml';
const MAIN_BRANCH_KEY = 'main-branch';

async function checkMainBranch(config: PatrolConfig): Promise<MainBranchStatus> {
  const notRed: MainBranchStatus = { isRed: false, runId: null, sha: '', htmlUrl: '' };

  // Check cooldown and abandoned status first
  if (isAbandoned(MAIN_BRANCH_KEY)) {
    log(`  ${cl.yellow}Main branch fix abandoned — needs human intervention${cl.reset}`);
    return notRed;
  }
  if (isRecentlyProcessed(MAIN_BRANCH_KEY, config.cooldownSeconds)) {
    log(`  ${cl.dim}Main branch recently processed — skipping${cl.reset}`);
    return notRed;
  }

  try {
    // Fetch the latest completed CI runs on main
    const resp = await githubApi<WorkflowRunsResponse>(
      `/repos/${config.repo}/actions/workflows/${CI_WORKFLOW}/runs?branch=main&status=completed&per_page=5`,
    );

    const runs = resp.workflow_runs ?? [];
    if (runs.length === 0) {
      log('  No completed CI runs on main found');
      return notRed;
    }

    const latest = runs[0];
    if (latest.conclusion === 'failure') {
      log(`  ${cl.red}🔴 Main branch CI is RED${cl.reset} (run #${latest.id}, sha ${latest.head_sha.slice(0, 8)})`);
      return {
        isRed: true,
        runId: latest.id,
        sha: latest.head_sha,
        htmlUrl: latest.html_url,
      };
    }

    log(`  ${cl.green}Main branch CI is green${cl.reset} (latest run #${latest.id}: ${latest.conclusion})`);
    return notRed;
  } catch (e) {
    log(`  ${cl.yellow}Warning: could not check main branch CI: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    return notRed;
  }
}

function buildMainBranchPrompt(runId: number, repo: string): string {
  return `You are a CI repair agent for the ${repo} repository.

## Situation

The CI workflow on the \`main\` branch is failing. Run ID: ${runId}

## Instructions

1. First, examine the CI failure logs:
   gh run view ${runId} --repo ${repo} --log-failed 2>/dev/null || gh run view ${runId} --repo ${repo} --log

2. Diagnose the root cause:
   - Is it a flaky test? (Check if re-running would fix it)
   - Is it a real build/test failure introduced by a recent commit?
   - Is it an infrastructure issue (network, package registry, etc.)?

3. If the failure looks flaky or transient:
   - Re-run the workflow: gh run rerun ${runId} --repo ${repo} --failed
   - That's it — no code changes needed

4. If it's a real failure that needs a code fix:
   - Create a fix branch: git checkout -b claude/fix-main-ci-$(date +%s) origin/main
   - Read the relevant source files and fix the issue
   - Run locally to verify: pnpm crux validate gate
   - Commit and push the fix branch
   - Open a PR: gh pr create --repo ${repo} --title "Fix main branch CI failure" --body "Fixes CI failure from run #${runId}"

## Guardrails
- Only fix the CI failure — do not refactor or improve unrelated code
- If the failure is in test expectations that need updating (not a real bug), update the tests
- If you cannot diagnose or fix the issue, output a clear summary of what you found
- Do NOT run /agent-session-start or /agent-session-ready-PR
- Run pnpm crux validate gate --fix before committing`;
}

async function fixMainBranch(status: MainBranchStatus, config: PatrolConfig): Promise<void> {
  log(`${cl.bold}→${cl.reset} Fixing main branch CI (run #${status.runId})`);

  if (config.dryRun) {
    log(`  ${cl.dim}[DRY RUN] Would invoke Claude to fix main branch CI${cl.reset}`);
    appendJsonl(JSONL_FILE, {
      type: 'main_branch_result',
      run_id: status.runId,
      sha: status.sha,
      outcome: 'dry-run' as FixOutcome,
      elapsed_s: 0,
    });
    markProcessed(MAIN_BRANCH_KEY);
    return;
  }

  const prompt = buildMainBranchPrompt(status.runId!, config.repo);
  const startTime = Date.now();

  let outcome: FixOutcome = 'fixed';
  let reason = '';

  try {
    const result = await spawnClaude(prompt, config);
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);

    if (result.timedOut) {
      const failCount = recordFailure(MAIN_BRANCH_KEY);
      outcome = 'timeout';
      reason = `Killed after ${config.timeoutMinutes}m timeout — attempt ${failCount}`;
      log(`${cl.red}✗ Main branch fix timed out after ${config.timeoutMinutes}m (attempt ${failCount})${cl.reset}`);

      if (failCount >= 2) {
        reason = `Abandoned after ${failCount} failures (timeout)`;
        log(`${cl.red}✗ Main branch fix abandoned after ${failCount} failures${cl.reset}`);
      }
    } else if (result.exitCode === 0 && !result.hitMaxTurns) {
      const isNoOp = looksLikeNoOp(result.output);
      outcome = isNoOp ? 'no-op' : 'fixed';
      if (isNoOp) {
        recordFailure(MAIN_BRANCH_KEY);
        reason = 'No-op: agent determined issue needs human intervention';
        log(`${cl.yellow}⚠ Main branch fix no-op — agent stopped early${cl.reset} (${elapsedS}s)`);
      } else {
        resetFailCount(MAIN_BRANCH_KEY);
        log(`${cl.green}✓ Main branch CI fix processed${cl.reset} (${elapsedS}s)`);
      }
    } else if (result.hitMaxTurns) {
      const failCount = recordFailure(MAIN_BRANCH_KEY);
      outcome = 'max-turns';
      reason = `Hit max turns (${config.maxTurns}) — attempt ${failCount}`;
      log(`${cl.yellow}⚠ Main branch fix hit max turns after ${elapsedS}s${cl.reset}`);

      if (failCount >= 2) {
        reason = `Abandoned after ${failCount} failures`;
        log(`${cl.red}✗ Main branch fix abandoned after ${failCount} failures${cl.reset}`);
      }
    } else {
      outcome = 'error';
      reason = `Exit code: ${result.exitCode}`;
      log(`${cl.red}✗ Main branch fix failed${cl.reset} (exit: ${result.exitCode}, ${elapsedS}s)`);
    }

    appendJsonl(JSONL_FILE, {
      type: 'main_branch_result',
      run_id: status.runId,
      sha: status.sha,
      outcome,
      elapsed_s: elapsedS,
      reason: reason || undefined,
    });
  } finally {
    // Clean up any in-progress rebase/merge
    gitSafe('rebase', '--abort');
    gitSafe('merge', '--abort');

    // Restore to main branch
    gitSafe('checkout', 'main');

    markProcessed(MAIN_BRANCH_KEY);
  }
}

// ── PR Overlap Detection ────────────────────────────────────────────────────

interface PrFiles {
  prNumber: number;
  title: string;
  files: string[];
}

interface PrFileEntry {
  filename: string;
}

interface CommitEntry {
  sha: string;
}

interface CommitDetail {
  files?: { filename: string }[];
}

/** Fetch commit SHAs for a PR. Cached per-call to avoid duplicate fetches. */
async function fetchPrCommitShas(
  config: PatrolConfig,
  prNumber: number,
  cache: Map<number, string[]>,
): Promise<string[]> {
  const cached = cache.get(prNumber);
  if (cached) return cached;
  try {
    const commits = await githubApi<CommitEntry[]>(
      `/repos/${config.repo}/pulls/${prNumber}/commits?per_page=100`,
    );
    const shas = commits.map((c) => c.sha);
    cache.set(prNumber, shas);
    return shas;
  } catch (e) {
    log(`  Warning: could not fetch commits for PR #${prNumber}: ${e instanceof Error ? e.message : String(e)}`);
    cache.set(prNumber, []);
    return [];
  }
}

/** Fetch files changed in a single commit. */
async function fetchCommitFiles(config: PatrolConfig, sha: string): Promise<string[]> {
  try {
    const detail = await githubApi<CommitDetail>(`/repos/${config.repo}/commits/${sha}`);
    return (detail.files ?? []).map((f) => f.filename);
  } catch (e) {
    log(`  Warning: could not fetch files for commit ${sha.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * For an overlapping PR pair, determine which overlapping files are fully
 * explained by shared commits (stacked branches). Returns the set of files
 * that are NOT from shared commits (i.e., genuine independent overlap).
 */
async function filterSharedCommitFiles(
  config: PatrolConfig,
  prA: number,
  prB: number,
  overlappingFiles: string[],
  commitCache: Map<number, string[]>,
): Promise<{ genuineOverlap: string[]; sharedCommitCount: number }> {
  const shaA = await fetchPrCommitShas(config, prA, commitCache);
  const shaB = await fetchPrCommitShas(config, prB, commitCache);

  const setA = new Set(shaA);
  const sharedShas = shaB.filter((sha) => setA.has(sha));

  if (sharedShas.length === 0) {
    return { genuineOverlap: overlappingFiles, sharedCommitCount: 0 };
  }

  // Fetch files for each shared commit and build a set
  const sharedCommitFiles = new Set<string>();
  for (const sha of sharedShas) {
    const files = await fetchCommitFiles(config, sha);
    for (const f of files) sharedCommitFiles.add(f);
  }

  const genuineOverlap = overlappingFiles.filter((f) => !sharedCommitFiles.has(f));
  return { genuineOverlap, sharedCommitCount: sharedShas.length };
}

async function detectPrOverlaps(config: PatrolConfig, prs: DetectedPr[]): Promise<void> {
  // Limit to first 20 PRs to avoid rate limits
  const prSubset = prs.slice(0, 20);
  if (prSubset.length < 2) return;

  log(`${cl.dim}Checking ${prSubset.length} PRs for file overlaps...${cl.reset}`);

  // Fetch changed files for each PR
  const prFiles: PrFiles[] = [];
  for (const pr of prSubset) {
    try {
      const files = await githubApi<PrFileEntry[]>(
        `/repos/${config.repo}/pulls/${pr.number}/files?per_page=100`,
      );
      prFiles.push({
        prNumber: pr.number,
        title: pr.title,
        files: files.map((f) => f.filename),
      });
    } catch (e) {
      log(`  ${cl.yellow}Warning: could not fetch files for PR #${pr.number}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    }
  }

  // Build file → PR map
  const fileMap = new Map<string, number[]>();
  for (const pf of prFiles) {
    for (const file of pf.files) {
      const existing = fileMap.get(file) ?? [];
      existing.push(pf.prNumber);
      fileMap.set(file, existing);
    }
  }

  // Find overlapping pairs
  const overlaps = new Map<string, string[]>(); // "A-B" → shared files
  for (const [file, prNums] of fileMap) {
    if (prNums.length < 2) continue;
    // Generate all pairs
    for (let i = 0; i < prNums.length; i++) {
      for (let j = i + 1; j < prNums.length; j++) {
        const key = `${Math.min(prNums[i], prNums[j])}-${Math.max(prNums[i], prNums[j])}`;
        const existing = overlaps.get(key) ?? [];
        existing.push(file);
        overlaps.set(key, existing);
      }
    }
  }

  if (overlaps.size === 0) {
    log(`  ${cl.dim}No file overlaps detected${cl.reset}`);
    return;
  }

  log(`  ${cl.yellow}Found ${overlaps.size} PR pair(s) with shared files${cl.reset}`);

  // Cache commit SHAs across pairs to avoid duplicate fetches
  const commitCache = new Map<number, string[]>();

  // Post warning comments (respecting cooldown)
  for (const [pairKey, sharedFiles] of overlaps) {
    const overlapKey = `overlap-${pairKey}`;
    if (isRecentlyProcessed(overlapKey, config.cooldownSeconds * 4)) {
      // Use 4× the normal cooldown since overlap warnings are informational
      continue;
    }

    const [aStr, bStr] = pairKey.split('-');
    const prA = parseInt(aStr, 10);
    const prB = parseInt(bStr, 10);
    let uniqueFiles = [...new Set(sharedFiles)];

    // Check if the overlap is explained by shared commits (stacked branches)
    const { genuineOverlap, sharedCommitCount } = await filterSharedCommitFiles(
      config, prA, prB, uniqueFiles, commitCache,
    );

    if (sharedCommitCount > 0 && genuineOverlap.length === 0) {
      log(`  PRs #${prA} and #${prB}: all ${uniqueFiles.length} overlapping file(s) from ${sharedCommitCount} shared commit(s) (stacked branches) — skipping warning`);
      markProcessed(overlapKey);
      appendJsonl(JSONL_FILE, {
        type: 'overlap_skipped_stacked',
        pr_a: prA,
        pr_b: prB,
        shared_files: uniqueFiles.length,
        shared_commits: sharedCommitCount,
      });
      continue;
    }

    if (sharedCommitCount > 0) {
      log(`  PRs #${prA} and #${prB}: ${uniqueFiles.length - genuineOverlap.length} file(s) from shared commits, ${genuineOverlap.length} genuine overlap(s)`);
      uniqueFiles = genuineOverlap;
    }

    const fileList = uniqueFiles.slice(0, 10).join('\n- ');
    const moreCount = uniqueFiles.length > 10 ? ` (+${uniqueFiles.length - 10} more)` : '';
    const stackedNote = sharedCommitCount > 0
      ? `\n\n_Note: These PRs share ${sharedCommitCount} commit(s) (stacked branches). Only independently-modified files are listed above._`
      : '';

    const body = `⚠️ **PR Overlap Warning**

This PR shares ${uniqueFiles.length} file(s) with PR #${prB}:
- ${fileList}${moreCount}

Coordinate to avoid merge conflicts.${stackedNote}

_Posted by PR Patrol — informational only._`;

    if (config.dryRun) {
      log(`  ${cl.dim}[DRY RUN] Would warn PR #${prA} and #${prB} about ${uniqueFiles.length} shared files${cl.reset}`);
    } else {
      // Post on both PRs
      for (const prNum of [prA, prB]) {
        const otherPr = prNum === prA ? prB : prA;
        const commentBody = body.replace(`PR #${prB}`, `PR #${otherPr}`);
        await githubApi(`/repos/${config.repo}/issues/${prNum}/comments`, {
          method: 'POST',
          body: { body: commentBody },
        }).catch((e) =>
          log(`  ${cl.yellow}Warning: could not post overlap comment on PR #${prNum}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`),
        );
      }
    }

    markProcessed(overlapKey);
    appendJsonl(JSONL_FILE, {
      type: 'overlap_warning',
      pr_a: prA,
      pr_b: prB,
      shared_files: uniqueFiles.length,
      shared_commits: sharedCommitCount,
    });
  }
}

// ── PR Detection (GraphQL) ──────────────────────────────────────────────────

const PR_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title headRefName mergeable isDraft createdAt updatedAt body
        labels(first: 20) { nodes { name } }
        commits(last: 1) { nodes { commit { statusCheckRollup {
          contexts(first: 50) { nodes {
            ... on CheckRun { conclusion }
            ... on StatusContext { state }
          }}
        }}}}
        reviewThreads(first: 50) { nodes {
          isResolved isOutdated path line startLine
          comments(first: 3) { nodes {
            author { login }
            body
          }}
        }}
      }
    }
  }
}`;

interface GqlReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  comments: {
    nodes: Array<{
      author: { login: string } | null;
      body: string;
    }>;
  };
}

export interface GqlPrNode {
  number: number;
  title: string;
  headRefName: string;
  mergeable: string;
  isDraft: boolean;
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
  reviewThreads?: { nodes: GqlReviewThread[] };
}

const KNOWN_BOT_LOGINS = new Set([
  'coderabbitai',
  'github-actions',
  'dependabot',
  'renovate',
]);

const ACTIONABLE_SEVERITY_RE = /🔴 Critical|🟠 Major|🟡 Minor|⚠️ Potential issue/;

/** Extract unresolved, non-outdated bot review comments from a PR node. */
function extractBotComments(pr: GqlPrNode): BotComment[] {
  const threads = pr.reviewThreads?.nodes ?? [];
  const comments: BotComment[] = [];

  for (const thread of threads) {
    if (thread.isResolved || thread.isOutdated) continue;
    const firstComment = thread.comments.nodes[0];
    if (!firstComment?.author?.login) continue;
    if (!KNOWN_BOT_LOGINS.has(firstComment.author.login)) continue;

    comments.push({
      path: thread.path,
      line: thread.line,
      startLine: thread.startLine,
      body: firstComment.body,
      author: firstComment.author.login,
    });
  }

  return comments;
}

/** Pure function — detects issues on a single PR node. */
export function detectIssues(
  pr: GqlPrNode,
  staleThresholdMs: number,
): { issues: PrIssueType[]; botComments: BotComment[] } {
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

  // Bot review comment detection
  const botComments = extractBotComments(pr);
  if (botComments.length > 0) {
    const hasActionable = botComments.some((c) => ACTIONABLE_SEVERITY_RE.test(c.body));
    issues.push(hasActionable ? 'bot-review-major' : 'bot-review-nitpick');
  }

  return { issues, botComments };
}

export async function fetchOpenPrs(config: PatrolConfig): Promise<GqlPrNode[]> {
  const [owner, name] = config.repo.split('/');
  const data = await githubGraphQL<{
    repository: { pullRequests: { nodes: GqlPrNode[] } };
  }>(PR_QUERY, { owner, name });
  const prs = data.repository.pullRequests.nodes;
  log(`Found ${cl.bold}${prs.length}${cl.reset} open PRs`);
  return prs;
}

const SINGLE_PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title headRefName mergeable isDraft createdAt updatedAt body
      labels(first: 20) { nodes { name } }
      commits(last: 1) { nodes { commit { statusCheckRollup {
        contexts(first: 50) { nodes {
          ... on CheckRun { conclusion }
          ... on StatusContext { state }
        }}
      }}}}
      reviewThreads(first: 50) { nodes {
        isResolved isOutdated path line startLine
        comments(first: 3) { nodes {
          author { login }
          body
        }}
      }}
    }
  }
}`;

/** Fetch a single PR by number. Used by `crux pr ready` for eligibility checks. */
export async function fetchSinglePr(prNumber: number): Promise<GqlPrNode | null> {
  const [owner, name] = REPO.split('/');
  try {
    const data = await githubGraphQL<{
      repository: { pullRequest: GqlPrNode | null };
    }>(SINGLE_PR_QUERY, { owner, name, number: prNumber });
    return data.repository.pullRequest;
  } catch (e) {
    log(`${cl.yellow}Warning: could not fetch PR #${prNumber}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    return null;
  }
}

function detectAllPrIssuesFromNodes(
  prs: GqlPrNode[],
  config: PatrolConfig,
): DetectedPr[] {
  const staleThresholdMs = Date.now() - config.staleHours * 3600 * 1000;

  return prs
    .filter((pr) => {
      const labels = pr.labels.nodes.map((l) => l.name);
      if (labels.includes('claude-working')) return false;
      // Skip draft PRs — they're not ready for automated fixes
      if (pr.isDraft) return false;
      return true;
    })
    .map((pr) => {
      const { issues, botComments } = detectIssues(pr, staleThresholdMs);
      return {
        number: pr.number,
        title: pr.title,
        branch: pr.headRefName,
        createdAt: pr.createdAt,
        issues,
        botComments,
      };
    })
    .filter((pr) => pr.issues.length > 0);
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const ISSUE_SCORES: Record<PrIssueType, number> = {
  conflict: 100,
  'ci-failure': 80,
  'bot-review-major': 55,
  'missing-issue-ref': 40,
  stale: 30,
  'missing-testplan': 20,
  'bot-review-nitpick': 15,
};

// ── Issue-type-specific resource limits ──────────────────────────────────────
// Scale max-turns and timeout based on the hardest issue in a PR.
// This prevents trivial issues from consuming the full 40-turn / 30-min budget.

interface IssueBudget {
  maxTurns: number;
  timeoutMinutes: number;
}

const ISSUE_BUDGETS: Record<PrIssueType, IssueBudget> = {
  conflict:            { maxTurns: 40, timeoutMinutes: 30 },
  'ci-failure':        { maxTurns: 25, timeoutMinutes: 15 },
  'bot-review-major':  { maxTurns: 25, timeoutMinutes: 15 },
  'missing-issue-ref': { maxTurns: 5,  timeoutMinutes: 3 },
  stale:               { maxTurns: 10, timeoutMinutes: 5 },
  'missing-testplan':  { maxTurns: 8,  timeoutMinutes: 5 },
  'bot-review-nitpick':{ maxTurns: 8,  timeoutMinutes: 5 },
};

/** Compute the budget for a PR based on its hardest issue. */
export function computeBudget(issues: PrIssueType[]): IssueBudget {
  let maxTurns = 5;
  let timeoutMinutes = 3;
  for (const issue of issues) {
    const budget = ISSUE_BUDGETS[issue];
    if (budget.maxTurns > maxTurns) maxTurns = budget.maxTurns;
    if (budget.timeoutMinutes > timeoutMinutes) timeoutMinutes = budget.timeoutMinutes;
  }
  return { maxTurns, timeoutMinutes };
}

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

// ── Merge eligibility ────────────────────────────────────────────────────────

/** Pure function — checks whether a PR with ready-to-merge label is eligible for auto-merge. */
export function checkMergeEligibility(pr: GqlPrNode): MergeCandidate {
  const blockReasons: MergeBlockReason[] = [];
  const labels = pr.labels.nodes.map((l) => l.name);

  if (pr.isDraft) {
    blockReasons.push('is-draft');
  }

  if (labels.includes('claude-working')) {
    blockReasons.push('claude-working');
  }

  if (pr.mergeable !== 'MERGEABLE') {
    blockReasons.push('not-mergeable');
  }

  const contexts =
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];

  const hasFailure = contexts.some(
    (c) =>
      c.conclusion === 'FAILURE' ||
      c.conclusion === 'CANCELLED' ||
      c.state === 'FAILURE' ||
      c.state === 'ERROR',
  );
  if (hasFailure) {
    blockReasons.push('ci-failing');
  }

  if (contexts.length > 0 && !hasFailure) {
    const hasPending = contexts.some(
      (c) =>
        (c.conclusion === null || c.conclusion === undefined) &&
        c.state !== 'SUCCESS',
    );
    if (hasPending) {
      blockReasons.push('ci-pending');
    }
  }

  const threads = pr.reviewThreads?.nodes ?? [];
  const unresolvedThreads = threads.filter(
    (t) => !t.isResolved && !t.isOutdated,
  );
  if (unresolvedThreads.length > 0) {
    blockReasons.push('unresolved-threads');
  }

  const body = pr.body ?? '';
  const uncheckedCheckboxes = [...body.matchAll(/^[\s]*-\s+\[ \]/gm)];
  if (uncheckedCheckboxes.length > 0) {
    blockReasons.push('unchecked-items');
  }

  return {
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    createdAt: pr.createdAt,
    eligible: blockReasons.length === 0,
    blockReasons,
  };
}

/** Find all PRs labeled ready-to-merge and check their merge eligibility. Sorted oldest first. */
export function findMergeCandidates(prs: GqlPrNode[]): MergeCandidate[] {
  return prs
    .filter((pr) => {
      const labels = pr.labels.nodes.map((l) => l.name);
      return labels.includes(READY_TO_MERGE_LABEL);
    })
    .map(checkMergeEligibility)
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
}

// ── Undraft execution ────────────────────────────────────────────────────────

async function undraftPr(prNum: number, config: PatrolConfig): Promise<boolean> {
  log(`${cl.bold}→${cl.reset} Undrafting PR ${cl.cyan}#${prNum}${cl.reset} (all eligibility checks pass)`);

  try {
    // GitHub REST API doesn't support undrafting — must use GraphQL mutation
    const prData = await githubApi<{ node_id: string }>(
      `/repos/${config.repo}/pulls/${prNum}`,
    );
    await githubGraphQL(
      `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
      { id: prData.node_id },
    );

    log(`${cl.green}✓ PR #${prNum} marked as ready for review${cl.reset}`);
    appendJsonl(JSONL_FILE, {
      type: 'undraft_result',
      pr_num: prNum,
      outcome: 'undrafted',
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`${cl.red}✗ Failed to undraft PR #${prNum}: ${msg}${cl.reset}`);
    appendJsonl(JSONL_FILE, {
      type: 'undraft_result',
      pr_num: prNum,
      outcome: 'error',
      reason: msg,
    });
    return false;
  }
}

// ── Merge execution ─────────────────────────────────────────────────────────

async function mergePr(
  candidate: MergeCandidate,
  config: PatrolConfig,
): Promise<void> {
  log(`${cl.bold}→${cl.reset} Merging PR ${cl.cyan}#${candidate.number}${cl.reset} (${candidate.title})`);
  log(`  Branch: ${cl.dim}${candidate.branch}${cl.reset}`);

  if (config.dryRun) {
    log(`  ${cl.dim}[DRY RUN] Would squash-merge this PR${cl.reset}`);
    appendJsonl(JSONL_FILE, {
      type: 'merge_result',
      pr_num: candidate.number,
      outcome: 'dry-run' as MergeOutcome,
    });
    return;
  }

  try {
    await githubApi(
      `/repos/${config.repo}/pulls/${candidate.number}/merge`,
      {
        method: 'PUT',
        body: {
          merge_method: 'squash',
        },
      },
    );

    log(`${cl.green}✓ PR #${candidate.number} merged successfully${cl.reset}`);

    await postEventComment(candidate.number, config.repo, buildMergeComment())
      .catch((e: unknown) => log(`  ${cl.yellow}Warning: could not post merge comment: ${e instanceof Error ? e.message : String(e)}${cl.reset}`));

    appendJsonl(JSONL_FILE, {
      type: 'merge_result',
      pr_num: candidate.number,
      outcome: 'merged' as MergeOutcome,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`${cl.red}✗ Failed to merge PR #${candidate.number}: ${msg}${cl.reset}`);

    await postEventComment(candidate.number, config.repo, buildMergeFailedComment(msg))
      .catch((e2: unknown) => log(`  ${cl.yellow}Warning: could not post merge failure comment: ${e2 instanceof Error ? e2.message : String(e2)}${cl.reset}`));

    appendJsonl(JSONL_FILE, {
      type: 'merge_result',
      pr_num: candidate.number,
      outcome: 'error' as MergeOutcome,
      reason: msg,
    });
  }
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
- **STOP IMMEDIATELY and report** if ANY of these apply:
  - The check requires a human action (adding a label like \`rules-change-reviewed\`, manual approval, etc.)
  - The failure is in a Vercel deployment or external service (not a code issue)
  - The same check is also failing on the \`main\` branch (pre-existing, not caused by this PR)
  - The failure is a permissions or authentication issue
- If the failure IS a code issue you can fix: fix it, run locally to verify (pnpm build / pnpm test), commit and push`);
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

  if (issues.includes('bot-review-major') || issues.includes('bot-review-nitpick')) {
    const isActionable = issues.includes('bot-review-major');
    sections.push(`
### Bot Review Comments${isActionable ? ' (Actionable)' : ' (Nitpick only)'}
- Automated code review bots (e.g., CodeRabbit) left unresolved comments on this PR
- Comments marked with 🔴 Critical, 🟠 Major, or 🟡 Minor should be addressed if the concern is valid
- Comments marked 🧹 Nitpick are optional — fix only if trivial and clearly correct
- Look for "Prompt for AI Agents" sections in the comments — these contain ready-made fix instructions
- VERIFY each suggestion against the current code before applying — bots can be wrong
- After addressing comments, commit and push the fixes`);

    if (pr.botComments.length > 0) {
      sections.push('\n#### Bot Comment Details\n');
      for (const c of pr.botComments) {
        const lineRange = c.startLine && c.startLine !== c.line
          ? `lines ${c.startLine}-${c.line}`
          : `line ${c.line}`;
        const body = c.body.length > 2000 ? c.body.slice(0, 2000) + '\n...(truncated)' : c.body;
        sections.push(`**${c.path}** (${lineRange}) — ${c.author}:\n${body}\n`);
      }
    }
  }

  sections.push(`
## Guardrails
- Only fix the detected issues — do not refactor or improve unrelated code
- If a conflict is too complex to resolve confidently, skip it and note why
- After any code changes, run: pnpm crux validate gate --fix
- Use git push --force-with-lease (never --force) when pushing rebased branches
- Do not modify files unrelated to the fix
- Do NOT run /agent-session-start or /agent-session-ready-PR — this is a targeted fix, not a full session
- Do NOT create new branches — work on the existing PR branch

## When to stop early
- **If the issue requires human intervention** (adding labels, approvals, external service fixes): output a clear summary of why and stop immediately. Do not attempt workarounds.
- **If the issue is pre-existing** (also failing on main, not introduced by this PR): state that and stop.
- **If you've tried 2+ approaches and none worked**: stop and summarize what you tried. Do not keep cycling through the same strategies.
- **If the fix is "no action needed"** (e.g., no matching issue exists for missing-issue-ref): say so and stop. Not every detected issue requires a code change.
- Stopping early with a clear explanation is BETTER than burning through all turns without progress.`);

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
    log(`  ${cl.yellow}Warning: could not add claude-working label to PR #${prNum}${cl.reset}`);
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
      log(`  ${cl.yellow}⚠ Claude subprocess timed out after ${config.timeoutMinutes}m — killing${cl.reset}`);
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
  log(`${cl.bold}→${cl.reset} Fixing PR ${cl.cyan}#${pr.number}${cl.reset} (${pr.title})`);
  log(`  Issues: ${cl.yellow}${pr.issues.join(', ')}${cl.reset}`);
  log(`  Branch: ${cl.dim}${pr.branch}${cl.reset}`);

  if (config.dryRun) {
    log(`  ${cl.dim}[DRY RUN] Would invoke Claude to fix${cl.reset}`);
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

  // Compute issue-specific budget (capped by global config)
  const budget = computeBudget(pr.issues);
  const effectiveMaxTurns = Math.min(budget.maxTurns, config.maxTurns);
  const effectiveTimeout = Math.min(budget.timeoutMinutes, config.timeoutMinutes);

  log(`  Budget: ${effectiveMaxTurns} max-turns, ${effectiveTimeout}m timeout (based on: ${pr.issues.join(', ')})`);

  // Post "attempting fix" event comment before spawning Claude
  await postEventComment(pr.number, config.repo, buildFixAttemptComment(pr.issues))
    .catch((e: unknown) => log(`  ${cl.yellow}Warning: could not post fix attempt comment: ${e instanceof Error ? e.message : String(e)}${cl.reset}`));

  const prompt = buildPrompt(pr, config.repo);
  const startTime = Date.now();

  let outcome: FixOutcome = 'fixed';
  let reason = '';

  try {
    const result = await spawnClaude(prompt, {
      ...config,
      maxTurns: effectiveMaxTurns,
      timeoutMinutes: effectiveTimeout,
    });
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);

    if (result.timedOut) {
      // Timeouts count toward abandonment — a PR that times out repeatedly
      // is likely unfixable and should not keep burning compute.
      const failCount = recordFailure(pr.number);
      outcome = 'timeout';
      reason = `Killed after ${effectiveTimeout}m timeout — attempt ${failCount}`;
      log(`${cl.red}✗ PR #${pr.number} timed out after ${effectiveTimeout}m (attempt ${failCount})${cl.reset}`);

      if (failCount >= 2) {
        reason = `Abandoned after ${failCount} failures (timeout)`;
        log(`${cl.red}✗ PR #${pr.number} abandoned after ${failCount} consecutive failures${cl.reset}`);
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(failCount, pr.issues))
          .catch((e: unknown) => log(`  ${cl.yellow}Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}${cl.reset}`));
      } else {
        await postEventComment(pr.number, config.repo, buildTimeoutComment(failCount, effectiveTimeout, pr.issues))
          .catch((e: unknown) => log(`  ${cl.yellow}Warning: could not post timeout comment: ${e instanceof Error ? e.message : String(e)}${cl.reset}`));
      }
    } else if (result.exitCode === 0 && !result.hitMaxTurns) {
      const isNoOp = looksLikeNoOp(result.output);
      outcome = isNoOp ? 'no-op' : 'fixed';

      if (isNoOp) {
        // No-op: Claude determined the issue can't be fixed automatically.
        // Don't reset fail count — treat like a soft failure so the PR
        // gets skipped on future cycles instead of being retried forever.
        const failCount = recordFailure(pr.number);
        reason = `No-op: agent determined issue needs human intervention (attempt ${failCount})`;
        log(`${cl.yellow}⚠ PR #${pr.number} no-op — agent stopped early${cl.reset} (${elapsedS}s)`);

        await postEventComment(pr.number, config.repo, buildNoOpComment(pr.issues))
          .catch((e: unknown) => log(`  ${cl.yellow}Warning: could not post no-op comment: ${e instanceof Error ? e.message : String(e)}${cl.reset}`));
      } else {
        resetFailCount(pr.number);
        log(`${cl.green}✓ PR #${pr.number} processed successfully${cl.reset} (${elapsedS}s)`);

        // Post fix-complete summary comment
        const outputTail = result.output.slice(-500);
        await postEventComment(pr.number, config.repo, buildFixCompleteComment(elapsedS, effectiveMaxTurns, config.model, pr.issues, outputTail))
          .catch((e: unknown) => log(`  ${cl.yellow}Warning: could not post fix-complete comment: ${e instanceof Error ? e.message : String(e)}${cl.reset}`));
      }
    } else if (result.hitMaxTurns) {
      const failCount = recordFailure(pr.number);
      outcome = 'max-turns';
      reason = `Hit max turns (${effectiveMaxTurns}) — attempt ${failCount}`;
      log(`${cl.yellow}⚠ PR #${pr.number} hit max turns after ${elapsedS}s (attempt ${failCount})${cl.reset}`);

      if (failCount >= 2) {
        reason = `Abandoned after ${failCount} failures`;
        log(
          `${cl.red}✗ PR #${pr.number} abandoned after ${failCount} consecutive failures${cl.reset}`,
        );
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(failCount, pr.issues))
          .catch((e: unknown) => log(`  ${cl.yellow}Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}${cl.reset}`));
      }
    } else {
      outcome = 'error';
      reason = `Exit code: ${result.exitCode}`;
      log(
        `${cl.red}✗ PR #${pr.number} processing failed${cl.reset} (exit: ${result.exitCode}, ${elapsedS}s)`,
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
    log(`${cl.dim}Skipping reflection — no log file yet${cl.reset}`);
    return;
  }

  const allEntries = readFileSync(JSONL_FILE, 'utf-8').trim().split('\n');
  if (allEntries.length < 10) {
    log(`${cl.dim}Skipping reflection — only ${allEntries.length} log entries (need ≥10)${cl.reset}`);
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
      model: 'haiku', // Reflection is log analysis — doesn't need sonnet
      timeoutMinutes: 5, // Should complete quickly
    });
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);

    if (result.timedOut || result.hitMaxTurns) {
      const reason = result.timedOut ? 'timeout' : 'max-turns';
      appendJsonl(REFLECTION_FILE, {
        cycle_number: cycleCount,
        elapsed_s: elapsedS,
        filed_issue: false,
        exit_code: result.exitCode,
        outcome: 'incomplete',
        reason,
        summary: result.output.slice(-500),
      });
      log(
        `${cl.yellow}⚠ Reflection incomplete${cl.reset} (${elapsedS}s, ${reason})`,
      );
    } else {
      const filedIssue = /Created issue #|created.*#\d/.test(result.output);
      appendJsonl(REFLECTION_FILE, {
        cycle_number: cycleCount,
        elapsed_s: elapsedS,
        filed_issue: filedIssue,
        exit_code: result.exitCode,
        outcome: 'complete',
        summary: result.output.slice(-500),
      });
      log(
        `${cl.green}✓ Reflection complete${cl.reset} (${elapsedS}s, filed_issue=${filedIssue})`,
      );
    }
  } catch (e) {
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);
    log(
      `${cl.red}✗ Reflection failed${cl.reset} (${elapsedS}s): ${e instanceof Error ? e.message : String(e)}`,
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

  // 0. Check main branch CI first — highest priority
  const mainStatus = await checkMainBranch(config);
  if (mainStatus.isRed) {
    log(`${cl.red}Main branch CI is red${cl.reset} — prioritizing fix over PR queue`);
    await fixMainBranch(mainStatus, config);
    appendJsonl(JSONL_FILE, {
      type: 'cycle_summary',
      cycle_number: cycleCount,
      prs_scanned: 0,
      queue_size: 0,
      pr_processed: null,
      main_branch_fix: true,
    });
    return; // Main takes the whole cycle; PRs wait
  }

  // 1. Fetch all open PRs (shared between fix and merge phases)
  const allPrs = await fetchOpenPrs(config);

  // ── Fix phase ──────────────────────────────────────────────────────

  const detected = detectAllPrIssuesFromNodes(allPrs, config);
  let fixedPr: number | null = null;

  // 1b. Check for PR file overlaps (informational — posts warnings)
  if (detected.length >= 2) {
    await detectPrOverlaps(config, detected);
  }

  if (detected.length === 0) {
    log(`${cl.dim}All PRs clean — nothing to fix${cl.reset}`);
  } else {
    // Filter cooldowns and abandoned
    const eligible = detected.filter((pr) => {
      if (isAbandoned(pr.number)) {
        log(`  ${cl.dim}Skipping PR #${pr.number} (abandoned — needs human intervention)${cl.reset}`);
        return false;
      }
      if (isRecentlyProcessed(pr.number, config.cooldownSeconds)) {
        log(`  ${cl.dim}Skipping PR #${pr.number} (recently processed)${cl.reset}`);
        return false;
      }
      return true;
    });

    const ranked = rankPrs(eligible);
    if (ranked.length > 0) {
      log('');
      log(`${cl.bold}Fix queue${cl.reset} (${ranked.length} items):`);
      for (const pr of ranked) {
        log(
          `  ${cl.yellow}[score=${pr.score}]${cl.reset} PR ${cl.cyan}#${pr.number}${cl.reset}: ${pr.issues.join(',')} ${cl.dim}—${cl.reset} ${pr.title}`,
        );
      }
      log('');

      const top = ranked[0];
      await fixPr(top, config);
      fixedPr = top.number;
    } else {
      log(`${cl.dim}All issues recently processed — nothing to fix${cl.reset}`);
    }
  }

  // ── Undraft phase ──────────────────────────────────────────────────
  // Auto-undraft draft PRs that are otherwise eligible for merge.
  // A PR is auto-undrafted when its only block reason is 'is-draft'.

  const draftCandidates = findMergeCandidates(allPrs).filter(
    (c) => !c.eligible && c.blockReasons.length === 1 && c.blockReasons[0] === 'is-draft',
  );

  const undraftedNumbers = new Set<number>();
  for (const candidate of draftCandidates) {
    if (config.dryRun) {
      log(`  ${cl.dim}[DRY RUN] Would undraft PR #${candidate.number} (all other checks pass)${cl.reset}`);
      undraftedNumbers.add(candidate.number);
    } else {
      const success = await undraftPr(candidate.number, config);
      if (success) undraftedNumbers.add(candidate.number);
    }
  }

  // ── Merge phase ────────────────────────────────────────────────────
  // Re-evaluate after undrafting (only successfully undrafted PRs become eligible)
  const mergeCandidates = findMergeCandidates(allPrs).map((c) => {
    if (undraftedNumbers.has(c.number)) {
      const updated = { ...c, blockReasons: c.blockReasons.filter((r) => r !== 'is-draft') };
      return { ...updated, eligible: updated.blockReasons.length === 0 };
    }
    return c;
  });
  const eligibleForMerge = mergeCandidates.filter((c) => c.eligible);
  const blockedForMerge = mergeCandidates.filter((c) => !c.eligible);
  let mergedPr: number | null = null;

  if (mergeCandidates.length > 0) {
    log('');
    log(`${cl.bold}Merge candidates${cl.reset} (${mergeCandidates.length} with ${READY_TO_MERGE_LABEL}):`);
    for (const mc of eligibleForMerge) {
      log(`  ${cl.green}✓${cl.reset} PR ${cl.cyan}#${mc.number}${cl.reset}: eligible ${cl.dim}—${cl.reset} ${mc.title}`);
    }
    for (const mc of blockedForMerge) {
      log(`  ${cl.red}✗${cl.reset} PR ${cl.cyan}#${mc.number}${cl.reset}: blocked (${mc.blockReasons.join(', ')}) ${cl.dim}—${cl.reset} ${mc.title}`);
    }

    // Upsert status comments on merge candidates so humans can see WHY
    // a PR can or cannot merge. Build a lookup from PR number to GqlPrNode.
    const prNodeByNumber = new Map(allPrs.map((p) => [p.number, p]));
    for (const mc of mergeCandidates) {
      const prNode = prNodeByNumber.get(mc.number);
      if (!prNode) continue;
      const statusBody = buildStatusCommentBody(prNode, mc.blockReasons);
      await upsertStatusComment(mc.number, config.repo, statusBody)
        .catch((e: unknown) => log(`  ${cl.yellow}Warning: could not upsert status comment on PR #${mc.number}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`));
    }
  }

  if (eligibleForMerge.length > 0) {
    const toMerge = eligibleForMerge[0];
    await mergePr(toMerge, config);
    mergedPr = toMerge.number;
  }

  // ── Cycle summary ──────────────────────────────────────────────────

  appendJsonl(JSONL_FILE, {
    type: 'cycle_summary',
    cycle_number: cycleCount,
    prs_scanned: allPrs.length,
    queue_size: detected.filter(
      (pr) =>
        !isAbandoned(pr.number) &&
        !isRecentlyProcessed(pr.number, config.cooldownSeconds),
    ).length,
    pr_processed: fixedPr,
    pr_merged: mergedPr,
    merge_candidates: mergeCandidates.length,
    merge_eligible: eligibleForMerge.length,
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
    `${cl.dim}Config: interval=${config.intervalSeconds}s, max-turns=${config.maxTurns}, cooldown=${config.cooldownSeconds}s, model=${config.model}${cl.reset}`,
  );
  log(`${cl.dim}Repo: ${config.repo}${cl.reset}`);
  log(`${cl.dim}JSONL: ${JSONL_FILE}${cl.reset}`);
  log(
    `${cl.dim}Mode: ${config.once ? 'single pass' : config.dryRun ? 'dry run' : 'continuous'}${cl.reset}`,
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
        `${cl.red}Check cycle failed: ${e instanceof Error ? e.message : String(e)}${cl.reset}`,
      );
    }

    // Periodic reflection
    if (cycleCount % config.reflectionInterval === 0) {
      try {
        await runReflection(cycleCount, config);
      } catch {
        log(`${cl.yellow}Reflection failed — continuing${cl.reset}`);
      }
    }

    log(`${cl.dim}Sleeping ${config.intervalSeconds}s until next check...${cl.reset}`);
    await new Promise((r) => setTimeout(r, config.intervalSeconds * 1000));
  }
}

// ── Status command (moved to log-reader.ts + format.ts) ─────────────────────
