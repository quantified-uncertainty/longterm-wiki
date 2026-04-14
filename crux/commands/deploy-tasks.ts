/**
 * Deploy Tasks Command Handlers
 *
 * Track post-deploy check tasks — auto-detect from diffs,
 * find pending tasks from merged PRs, inject into PR descriptions.
 *
 * Usage:
 *   crux gh deploy-tasks detect             Detect deploy tasks from current branch diff
 *   crux gh deploy-tasks pending            Find unchecked tasks from recently merged PRs
 *   crux gh deploy-tasks inject             Output deploy tasks section (or update a PR)
 *   crux gh deploy-tasks verify             Run embedded verify commands for unchecked tasks
 */

import { spawnSync } from 'child_process';

import { createLogger } from '../lib/output.ts';
import type { CommandOptions, CommandResult } from '../lib/command-types.ts';
import {
  detectDeployTasks,
  extractVerifyCommand,
  parseDeployTasksFromBody,
  formatDeployTasksSection,
} from '../lib/deploy-tasks/detect.ts';
import { githubApi, REPO } from '../lib/github.ts';

// ── detect ──────────────────────────────────────────────────────────────────

async function detect(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const baseRef = (options.base as string) || 'origin/main';

  const result = detectDeployTasks(baseRef);

  if (result.error) {
    if (options.ci) {
      return {
        output: JSON.stringify({ error: result.error }, null, 2) + '\n',
        exitCode: 1,
      };
    }
    return {
      output: `${c.red}Error:${c.reset} ${result.error}\n`,
      exitCode: 1,
    };
  }

  if (options.ci) {
    return {
      output: JSON.stringify(result, null, 2) + '\n',
      exitCode: 0,
    };
  }

  if (result.tasks.length === 0) {
    return { output: `${c.green}No deploy tasks detected.${c.reset}\n`, exitCode: 0 };
  }

  const lines: string[] = [];
  lines.push(
    `${c.bold}Deploy Tasks Detected${c.reset} (${result.tasks.length} task${result.tasks.length === 1 ? '' : 's'} from ${result.filesAnalyzed} files):\n`
  );

  // Group tasks by category
  const byCategory = new Map<string, typeof result.tasks>();
  for (const task of result.tasks) {
    if (!byCategory.has(task.category)) byCategory.set(task.category, []);
    byCategory.get(task.category)!.push(task);
  }

  for (const [category, tasks] of byCategory) {
    lines.push(`${c.cyan}${category}${c.reset}`);
    for (const task of tasks) {
      const meta = `${task.phase}, ${task.automated ? 'automated' : 'manual'}`;
      lines.push(`  ${c.yellow}\u2610${c.reset} ${task.description} ${c.dim}[${meta}]${c.reset}`);
      if (task.sourceFiles.length > 0) {
        lines.push(`    ${c.dim}Source: ${task.sourceFiles.join(', ')}${c.reset}`);
      }
    }
    lines.push('');
  }

  return { output: lines.join('\n').trimEnd() + '\n', exitCode: 0 };
}

// ── pending ─────────────────────────────────────────────────────────────────

interface PrData {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  updated_at: string | null;
}

function daysAgo(dateStr: string): number {
  const then = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Result of a commit-on-production check. `on` is the answer; `error` is set
 * to a short message when the compare call failed (so we know to surface
 * degraded roll-off behavior to the operator instead of silently reporting
 * `rolledOff: 0`).
 */
export interface CommitOnProductionResult {
  on: boolean;
  error?: string;
}

/**
 * Returns true if the given commit is already on production — i.e. it has
 * been deployed. Uses GitHub's compare API: `production...{sha}` with
 * `ahead_by === 0` means {sha} has no commits not already on production.
 *
 * Used to auto-roll-off deploy tasks from PRs whose code is already live
 * (QUA-450 Fix 3 — tasks for old PRs kept showing up in `deploy-tasks
 * pending/verify` output on every new release, drowning the real signal).
 *
 * Exported for unit testing. Returns a `{ on, error? }` tuple so callers can
 * distinguish "confirmed not deployed" from "compare call failed, assumed
 * not deployed".
 */
export async function isCommitOnProduction(
  commitSha: string,
  api: typeof githubApi = githubApi,
): Promise<CommitOnProductionResult> {
  if (!commitSha) return { on: false };
  try {
    const result = await api<{ ahead_by: number }>(
      `/repos/${REPO}/compare/production...${encodeURIComponent(commitSha)}`,
    );
    return { on: result.ahead_by === 0 };
  } catch (e) {
    // If compare fails (network error, unknown SHA, production branch
    // missing), treat as "not deployed" — i.e. keep the task visible.
    // Fail-open here, because the opposite (fail-closed = silently roll
    // off everything on any glitch) is the exact silent-drop bug we fear.
    // The error is bubbled up so the caller can count failures and report
    // degraded roll-off behavior instead of reporting rolledOff: 0.
    const msg = e instanceof Error ? e.message : String(e);
    return { on: false, error: msg };
  }
}

/**
 * Filter a list of PRs to drop those whose merge commit is already on
 * production. When `includeDeployed` is true, returns the list unchanged.
 * Returns both the filtered list, the number of rolled-off PRs, and the
 * number of compare failures so the caller can log degraded behavior.
 */
async function rollOffDeployedPrs<T extends { number: number; merge_commit_sha: string | null }>(
  prs: T[],
  includeDeployed: boolean,
): Promise<{ kept: T[]; rolledOff: number; compareFailures: number }> {
  if (includeDeployed) return { kept: prs, rolledOff: 0, compareFailures: 0 };
  const checks = await Promise.all(
    prs.map(async (pr) => {
      if (!pr.merge_commit_sha) return { pr, deployed: false, error: undefined as string | undefined };
      const res = await isCommitOnProduction(pr.merge_commit_sha);
      return { pr, deployed: res.on, error: res.error };
    }),
  );
  const kept = checks.filter((c) => !c.deployed).map((c) => c.pr);
  const compareFailures = checks.filter((c) => c.error !== undefined).length;
  return { kept, rolledOff: prs.length - kept.length, compareFailures };
}

/**
 * Fetch merged PRs that were merged within `lookbackDays` of now, paginating
 * over GitHub's Pulls API until we're confident no younger merged PRs remain.
 *
 * Sorts by `updated` descending. For any PR, `updated_at >= merged_at`, so
 * once a full page's `updated_at` values are all older than the cutoff, every
 * subsequent page is guaranteed to have `merged_at < cutoff` as well — no more
 * merged PRs in the window are reachable and we can stop.
 *
 * Rationale (QUA-450 review): the previous implementation only looked at the
 * first 30 PRs sorted by `created`, which silently dropped any PR whose
 * creation was older than the 30 most-recently-created closed PRs. Long-lived
 * branches merged today, or any PR pushed past the first page by closure
 * volume, were silently skipped — losing their deploy tasks entirely.
 *
 * `maxPages` is a hard safety cap so a broken cutoff comparison can't cause
 * an unbounded scan.
 */
export async function fetchMergedPrsInWindow(
  cutoff: Date,
  api: typeof githubApi = githubApi,
  opts: { perPage?: number; maxPages?: number } = {},
): Promise<PrData[]> {
  const perPage = opts.perPage ?? 100;
  const maxPages = opts.maxPages ?? 10;
  const result: PrData[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const batch = await api<PrData[]>(
      `/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const pr of batch) {
      // Only merged PRs with merge_at inside the cutoff window matter.
      if (pr.merged_at && new Date(pr.merged_at) >= cutoff) {
        result.push(pr);
      }
    }

    // Stop when every PR in this page has `updated_at < cutoff`. Because
    // `updated_at >= merged_at`, this also guarantees every subsequent page's
    // merged_at is older than cutoff.
    const allPastCutoff = batch.every((pr) => {
      const updated = pr.updated_at ? new Date(pr.updated_at) : null;
      return updated !== null && updated < cutoff;
    });
    if (allPastCutoff) break;

    // Short final page — no more results at all.
    if (batch.length < perPage) break;
  }

  return result;
}

async function pending(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const lookbackDays = Number(options.days) || 14;
  const includeDeployed = Boolean(options.includeDeployed ?? options['include-deployed']);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  // Paginate by updated-desc until we've seen everything inside the cutoff.
  // QUA-450 review fix: the previous `sort=created&per_page=30` single page
  // silently dropped any merged PR older than the 30 most-recently-created
  // closed PRs.
  const rawPrs = await fetchMergedPrsInWindow(cutoff);

  // Narrow to merged PRs with deploy tasks before the (potentially
  // expensive) per-PR production-ancestry check. `fetchMergedPrsInWindow`
  // already guarantees `merged_at >= cutoff`, so we only re-check the body.
  const candidates = rawPrs.filter((pr) => {
    if (!pr.body) return false;
    const parsed = parseDeployTasksFromBody(pr.body);
    return parsed !== null && parsed.unchecked > 0;
  });

  // QUA-450: drop PRs whose code is already on production.
  const { kept: prs, rolledOff, compareFailures } = await rollOffDeployedPrs(
    candidates,
    includeDeployed,
  );

  const pendingPrs: Array<{
    number: number;
    title: string;
    mergedDaysAgo: number;
    uncheckedTasks: string[];
  }> = [];

  for (const pr of prs) {
    const parsed = parseDeployTasksFromBody(pr.body!);
    if (!parsed) continue; // narrowed above, but satisfy TS
    const unchecked = parsed.items.filter((t) => !t.checked).map((t) => t.text);
    pendingPrs.push({
      number: pr.number,
      title: pr.title,
      mergedDaysAgo: daysAgo(pr.merged_at!),
      uncheckedTasks: unchecked,
    });
  }

  if (options.ci) {
    return {
      output:
        JSON.stringify(
          { pendingPrs, lookbackDays, rolledOff, compareFailures },
          null,
          2,
        ) + '\n',
      exitCode: 0,
    };
  }

  // If the compare API is glitching, `rolledOff: 0` could just mean
  // "we never successfully checked". Surface that to the operator.
  const compareWarning =
    compareFailures > 0
      ? ` ${c.yellow}[${compareFailures} compare failure${compareFailures === 1 ? '' : 's'} — roll-off degraded]${c.reset}`
      : '';

  if (pendingPrs.length === 0) {
    const rolledOffNote = rolledOff > 0
      ? ` ${c.dim}(${rolledOff} task-bearing PR${rolledOff === 1 ? '' : 's'} rolled off — already on production)${c.reset}`
      : '';
    return {
      output: `${c.green}No pending deploy tasks. All clear!${c.reset}${rolledOffNote}${compareWarning}\n`,
      exitCode: 0,
    };
  }

  const totalUnchecked = pendingPrs.reduce((sum, pr) => sum + pr.uncheckedTasks.length, 0);
  const lines: string[] = [];
  const rolledOffNote = rolledOff > 0
    ? ` ${c.dim}[${rolledOff} rolled off]${c.reset}`
    : '';
  lines.push(
    `${c.bold}Pending Deploy Tasks${c.reset} (${totalUnchecked} unchecked across ${pendingPrs.length} PR${pendingPrs.length === 1 ? '' : 's'})${rolledOffNote}${compareWarning}:\n`
  );

  for (const pr of pendingPrs) {
    lines.push(
      `${c.cyan}PR #${pr.number}${c.reset} (merged ${pr.mergedDaysAgo}d ago): ${c.dim}"${pr.title}"${c.reset}`
    );
    for (const task of pr.uncheckedTasks) {
      lines.push(`  ${c.yellow}\u2610${c.reset} ${task}`);
    }
    lines.push('');
  }

  return { output: lines.join('\n').trimEnd() + '\n', exitCode: 0 };
}

// ── verify ──────────────────────────────────────────────────────────────────

interface VerifyResult {
  pr: number;
  prTitle: string;
  task: string;
  command: string | null;
  /**
   * - pass: verify command succeeded
   * - fail: real failure — needs investigation
   * - skip: prerequisite missing (e.g. psql), dry-run, or no verify command
   * - needs-ui: command returned HTTP 403 "Resource not accessible by personal
   *   access token" — only fixable by dispatching from the GitHub UI or
   *   granting the PAT `actions:write`. Distinguishable from `fail` so
   *   coordinator scans don't drown in PAT-blocked rows each release. (QUA-409)
   */
  status: 'pass' | 'fail' | 'skip' | 'needs-ui';
  exitCode?: number;
  output?: string;
  skipReason?: string;
}

/**
 * Detect the GitHub "Resource not accessible by ..." family of errors,
 * which surface when a `gh workflow run` / `gh api` task is verified with a
 * token that lacks the required scope (classic PAT missing `actions:write`,
 * fine-grained PAT, or an installation token). (QUA-409)
 */
export function isPatBlockedError(output: string | undefined): boolean {
  if (!output) return false;
  // Covers "...by personal access token", "...by integration", "...by user".
  return /Resource not accessible by (?:personal access token|integration|user)/i.test(output);
}

/**
 * Determine whether a `psql`-based verify command can actually run in the
 * current environment. Returns `{ runnable: true }` for non-psql commands and
 * for psql commands when both `psql` is on PATH and `DATABASE_URL` is set.
 *
 * Exported for unit testing. Callers can inject a probe via `deps` to avoid
 * shelling out in tests.
 *
 * This exists because `crux gh deploy-tasks verify` is typically invoked from
 * coordinator workstations that don't have `psql` installed and don't carry
 * `DATABASE_URL` in their environment (the DB lives in k8s). Without this
 * pre-check, every migration task reports FAIL with exit 127, eroding the
 * signal-to-noise ratio of `/deploy` Step 5 — see QUA-319.
 */
export function checkPsqlRunnable(
  command: string,
  deps: {
    hasPsql?: () => boolean;
    getDatabaseUrl?: () => string | undefined;
  } = {}
): { runnable: true } | { runnable: false; reason: string } {
  // Only gate psql commands. Other verify patterns (curl, gh, pnpm) are
  // either ambient on any workstation or already fail loudly for other reasons.
  if (!/\bpsql\b/.test(command)) {
    return { runnable: true };
  }

  const getDatabaseUrl = deps.getDatabaseUrl ?? (() => process.env.DATABASE_URL);
  const hasPsql = deps.hasPsql ?? defaultHasPsql;

  const dbUrl = getDatabaseUrl();
  if (!dbUrl || dbUrl.trim() === '') {
    return {
      runnable: false,
      reason:
        'DATABASE_URL is not set — cannot run psql verification locally. Run this from a deploy environment with DB access, or export DATABASE_URL before retrying.',
    };
  }

  if (!hasPsql()) {
    return {
      runnable: false,
      reason:
        'psql is not installed on PATH — cannot run psql verification locally. Install the Postgres client or run this from a machine with psql + DB access.',
    };
  }

  return { runnable: true };
}

let cachedHasPsql: boolean | undefined;
function defaultHasPsql(): boolean {
  if (cachedHasPsql !== undefined) return cachedHasPsql;
  const probe = spawnSync('command', ['-v', 'psql'], {
    shell: true,
    stdio: 'ignore',
  });
  cachedHasPsql = probe.status === 0;
  return cachedHasPsql;
}

/**
 * Run a shell command via `bash -c` with a timeout. Captures combined stdout +
 * stderr (truncated to keep output reviewable). Returns exit code 124 on
 * timeout, mirroring GNU coreutils' `timeout` exit convention.
 */
function runVerifyCommand(
  command: string,
  timeoutMs: number
): { exitCode: number; output: string } {
  const result = spawnSync('bash', ['-c', command], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024, // 1MB cap
  });

  // spawnSync sets `signal` on timeout (typically SIGTERM); the docs are
  // explicit that exit code is null in that case.
  if (result.signal) {
    return {
      exitCode: 124,
      output: `[timeout after ${timeoutMs}ms] ${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    };
  }
  // spawnSync.error fires for things like ENOENT (bash missing) — surface it.
  if (result.error) {
    return { exitCode: 1, output: `[spawn error] ${result.error.message}` };
  }
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  // Truncate to keep terminal output reviewable. Full output stays in JSON mode.
  const truncated =
    combined.length > 500 ? combined.slice(0, 500) + '\n... [truncated]' : combined;
  return { exitCode: result.status ?? 1, output: truncated };
}

async function verify(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const lookbackDays = Number(options.days) || 14;
  const dryRun = Boolean(options.dryRun ?? options['dry-run']);
  const timeoutMs = Number(options.timeout) || 30_000;
  const includeDeployed = Boolean(options.includeDeployed ?? options['include-deployed']);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  // QUA-450 review fix: paginate by updated-desc instead of `sort=created`
  // first-page-only, so long-lived PRs merged inside the window aren't
  // silently skipped. See `fetchMergedPrsInWindow` for the stop condition.
  const rawPrs = await fetchMergedPrsInWindow(cutoff);

  // Narrow to merged-with-tasks before the per-PR compare call.
  const candidates = rawPrs.filter((pr) => {
    if (!pr.body) return false;
    const parsed = parseDeployTasksFromBody(pr.body);
    return parsed !== null && parsed.unchecked > 0;
  });

  // QUA-450: drop PRs whose code is already on production.
  const { kept: prs, rolledOff, compareFailures } = await rollOffDeployedPrs(
    candidates,
    includeDeployed,
  );

  const results: VerifyResult[] = [];

  for (const pr of prs) {
    if (!pr.body) continue; // narrowed above
    const parsed = parseDeployTasksFromBody(pr.body);
    if (!parsed || parsed.unchecked === 0) continue;

    for (const item of parsed.items) {
      if (item.checked) continue;

      const command = extractVerifyCommand(item.text);
      if (!command) {
        results.push({
          pr: pr.number,
          prTitle: pr.title,
          task: item.text,
          command: null,
          status: 'skip',
        });
        continue;
      }

      if (dryRun) {
        results.push({
          pr: pr.number,
          prTitle: pr.title,
          task: item.text,
          command,
          status: 'skip',
          output: '[dry-run]',
        });
        continue;
      }

      const runnable = checkPsqlRunnable(command);
      if (!runnable.runnable) {
        results.push({
          pr: pr.number,
          prTitle: pr.title,
          task: item.text,
          command,
          status: 'skip',
          skipReason: runnable.reason,
        });
        continue;
      }

      const { exitCode, output } = runVerifyCommand(command, timeoutMs);
      let status: VerifyResult['status'];
      if (exitCode === 0) status = 'pass';
      // Gate PAT-blocked detection on `gh ` commands so an unrelated 403
      // (e.g. curl against a third-party API) isn't miscategorized.
      else if (/\bgh\b/.test(command) && isPatBlockedError(output)) status = 'needs-ui';
      else status = 'fail';
      results.push({
        pr: pr.number,
        prTitle: pr.title,
        task: item.text,
        command,
        status,
        exitCode,
        output,
      });
    }
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const needsUi = results.filter((r) => r.status === 'needs-ui').length;
  const skipped = results.filter((r) => r.status === 'skip').length;

  if (options.ci) {
    return {
      output:
        JSON.stringify(
          {
            results,
            summary: {
              passed,
              failed,
              needsUi,
              skipped,
              rolledOff,
              compareFailures,
              total: results.length,
            },
          },
          null,
          2
        ) + '\n',
      exitCode: failed > 0 ? 1 : 0,
    };
  }

  const compareWarning =
    compareFailures > 0
      ? ` ${c.yellow}[${compareFailures} compare failure${compareFailures === 1 ? '' : 's'} — roll-off degraded]${c.reset}`
      : '';

  if (results.length === 0) {
    const rolledOffNote = rolledOff > 0
      ? ` ${c.dim}(${rolledOff} task-bearing PR${rolledOff === 1 ? '' : 's'} rolled off — already on production)${c.reset}`
      : '';
    return {
      output: `${c.green}No pending deploy tasks to verify.${c.reset}${rolledOffNote}${compareWarning}\n`,
      exitCode: 0,
    };
  }

  // Group by PR for human-readable output
  const byPr = new Map<number, VerifyResult[]>();
  for (const r of results) {
    if (!byPr.has(r.pr)) byPr.set(r.pr, []);
    byPr.get(r.pr)!.push(r);
  }

  const lines: string[] = [];
  const headerSuffix = (dryRun ? ' (dry-run)' : '') +
    (rolledOff > 0 ? ` ${c.dim}[${rolledOff} PR${rolledOff === 1 ? '' : 's'} rolled off]${c.reset}` : '') +
    compareWarning;
  lines.push(`${c.bold}Deploy Tasks Verification${c.reset}${headerSuffix}\n`);

  for (const [prNum, prResults] of byPr) {
    const title = prResults[0].prTitle;
    lines.push(`${c.cyan}PR #${prNum}${c.reset} ${c.dim}"${title}"${c.reset}`);
    for (const r of prResults) {
      let badge: string;
      if (r.status === 'pass') badge = `${c.green}PASS${c.reset}`;
      else if (r.status === 'fail') badge = `${c.red}FAIL${c.reset}`;
      else if (r.status === 'needs-ui') badge = `${c.yellow}NEEDS-UI${c.reset}`;
      else badge = `${c.yellow}SKIP${c.reset}`;
      lines.push(`  ${badge}  ${r.task}`);
      if (r.status === 'fail' && r.output) {
        // Indent failure output for readability
        const indented = r.output
          .split('\n')
          .map((l) => `        ${c.dim}${l}${c.reset}`)
          .join('\n');
        lines.push(`        ${c.dim}exit=${r.exitCode}${c.reset}`);
        lines.push(indented);
      }
      if (r.status === 'needs-ui') {
        lines.push(
          `        ${c.dim}Token lacks actions:write — dispatch from GitHub UI or grant the scope.${c.reset}`
        );
      }
      if (r.status === 'skip' && r.skipReason) {
        lines.push(`        ${c.dim}${r.skipReason}${c.reset}`);
      }
    }
    lines.push('');
  }

  const needsUiPart =
    needsUi > 0 ? `, ${c.yellow}${needsUi} needs-ui${c.reset}` : '';
  lines.push(
    `${c.bold}Summary:${c.reset} ${c.green}${passed} passed${c.reset}, ${
      failed > 0 ? c.red : c.dim
    }${failed} failed${c.reset}${needsUiPart}, ${c.dim}${skipped} skipped${c.reset}`
  );

  return {
    output: lines.join('\n').trimEnd() + '\n',
    exitCode: failed > 0 ? 1 : 0,
  };
}

// ── inject ──────────────────────────────────────────────────────────────────

async function inject(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const baseRef = (options.base as string) || 'origin/main';
  const prNumber = options.pr ? Number(options.pr) : null;

  const result = detectDeployTasks(baseRef);

  if (result.error) {
    return {
      output: `${c.red}Error:${c.reset} ${result.error}\n`,
      exitCode: 1,
    };
  }

  const section = formatDeployTasksSection(result.tasks);

  if (!prNumber) {
    return { output: section + '\n', exitCode: 0 };
  }

  // Fetch current PR body and update it
  const pr = await githubApi<{ body: string | null }>(
    `/repos/${REPO}/pulls/${prNumber}`
  );
  let body = pr.body || '';

  const startMarker = '<!-- deploy-tasks:v1 -->';
  const endMarker = '<!-- /deploy-tasks -->';
  const startIdx = body.indexOf(startMarker);
  const endIdx = body.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing section (including ## Deploy Checklist header if present)
    let sectionStart = startIdx;
    const beforeMarker = body.slice(0, startIdx);
    const headerIdx = beforeMarker.lastIndexOf('## Deploy Checklist');
    if (headerIdx !== -1) {
      sectionStart = headerIdx;
    }
    body = body.slice(0, sectionStart) + section + body.slice(endIdx + endMarker.length);
  } else {
    // Append before last --- separator or at end
    const lastSepIdx = body.lastIndexOf('\n---');
    if (lastSepIdx !== -1) {
      body = body.slice(0, lastSepIdx) + '\n\n' + section + body.slice(lastSepIdx);
    } else {
      body = body + '\n\n' + section;
    }
  }

  await githubApi(`/repos/${REPO}/pulls/${prNumber}`, {
    method: 'PATCH',
    body: { body },
  });

  return {
    output: `${c.green}✓${c.reset} Updated PR #${prNumber} with deploy tasks section.\n\n${section}\n`,
    exitCode: 0,
  };
}

// ── exports ─────────────────────────────────────────────────────────────────

export const commands = {
  detect,
  pending,
  inject,
  verify,
};

export function getHelp(): string {
  return `Deploy Tasks — Track post-deploy check tasks

Commands:
  detect                Detect deploy tasks from current branch diff.
  pending               Find unchecked deploy tasks from recently merged PRs.
  inject                Inject deploy tasks section into a PR description.
  verify                Run embedded verify commands for unchecked deploy tasks.

Options (detect):
  --base=<ref>          Base ref for diff (default: origin/main).
  --ci                  JSON output.

Options (pending):
  --days=N              Lookback window in days (default: 14).
  --include-deployed    Show tasks from PRs already on production (by default
                        they are rolled off — QUA-450).
  --ci                  JSON output.

Options (inject):
  --pr=N                Update PR #N's description (otherwise prints to stdout).
  --base=<ref>          Base ref for diff (default: origin/main).

Options (verify):
  --days=N              Lookback window in days (default: 14).
  --timeout=N           Per-command timeout in milliseconds (default: 30000).
  --dry-run             Print commands without executing them.
  --include-deployed    Verify tasks from PRs already on production (by
                        default they are rolled off — QUA-450).
  --ci                  JSON output.

Environment for verify:
  Tasks may reference shell variables like \$DATABASE_URL, \$WIKI_SERVER_URL.
  Set these in the calling shell — verify inherits the parent environment.

Examples:
  pnpm crux gh deploy-tasks detect                # Show tasks for current branch
  pnpm crux gh deploy-tasks pending               # Show unchecked tasks from recent PRs
  pnpm crux gh deploy-tasks inject --pr=3270      # Add tasks section to PR #3270
  pnpm crux gh deploy-tasks verify                # Run verify commands for pending tasks
  pnpm crux gh deploy-tasks verify --dry-run      # Show what would run`;
}

// ---------------------------------------------------------------------------
// Command injection prevention for deploy-task verification
// ---------------------------------------------------------------------------

const ALLOWED_PATTERNS: RegExp[] = [
  // gh run list/view — only for workflow status checks
  /^gh run (?:list|view) --workflow="[\w.-]+" --limit=\d+ --json [\w,]+$/,
  // Health endpoint — only $WIKI_SERVER_URL/health piped to jq
  /^curl -sf "\$WIKI_SERVER_URL\/health" \| jq \.$/,
  // Migration check — only SELECT from drizzle migrations
  /^psql "\$DATABASE_URL" -c "SELECT \* FROM drizzle\.__drizzle_migrations ORDER BY created_at DESC LIMIT \d+;"$/,
  // Route check — only $WIKI_SERVER_URL paths, no traversal
  /^curl -sf "\$WIKI_SERVER_URL\/[\w/.-]+" -o \/dev\/null -w "%\{http_code\}"$/,
  // Build check — specific pnpm commands
  /^pnpm build-data:content && echo "Build data OK"$/,
];

/**
 * Validate a deploy-task verification command against allowed patterns.
 * Prevents command injection by only allowing known-safe patterns.
 */
export function isAllowedCommand(cmd: string): boolean {
  if (!cmd) return false;
  // Block command substitution
  if (/\$\(|`/.test(cmd)) return false;
  // Block path traversal
  if (/\.\.\//.test(cmd)) return false;
  // Block multiple pipes (beyond the single allowed health-check pipe)
  if ((cmd.match(/\|/g) || []).length > 1) return false;
  // Block unquoted semicolons (command chaining). Semicolons inside
  // double-quoted strings (like psql -c "...;") are safe.
  if (/;(?=(?:[^"]*"[^"]*")*[^"]*$)/.test(cmd)) return false;
  // Block && except in approved build patterns
  if (/&&/.test(cmd) && !ALLOWED_PATTERNS.some((p) => p.test(cmd))) return false;
  return ALLOWED_PATTERNS.some((p) => p.test(cmd));
}
