/**
 * PR Patrol — Branch Agent Mode (Phase 1)
 *
 * A persistent per-PR watchdog that dedicates full attention to a single PR.
 * Unlike the daemon (which fixes one PR per cycle across all open PRs), the
 * branch agent watches one PR continuously: fix → wait for CI → fix → repeat.
 *
 * Key differences from the main daemon:
 * - Focuses on ONE PR — richer context, no priority competition
 * - Multi-cycle: runs many short fix sessions (10-15 min each) rather than
 *   one long 30-minute session that times out mid-flight
 * - Waits for CI to complete between fix cycles (watches CI progress)
 * - Has a per-run invocation cap to prevent runaway costs
 * - Does not participate in the global cooldown/abandonment system
 *
 * Phase 1 of the persistent patrol brain design described in discussion #1882.
 */

import { githubApi } from '../lib/github.ts';
import { appendJsonl, cl, log, JSONL_FILE } from './state.ts';
import { fetchSinglePr } from '../lib/pr-analysis/index.ts';
import { detectIssues, computeScore } from '../lib/pr-analysis/index.ts';
import { spawnClaude, releaseCurrentClaim } from './execution.ts';
import { LABELS } from '../lib/labels.ts';
import { buildBranchAgentPrompt } from './prompts.ts';
import { computeBudget } from './scoring.ts';
import type { PatrolConfig } from './types.ts';
import type { ScoredPr, GqlPrNode } from './types.ts';
import { parseIntOpt } from '../lib/cli.ts';
import type { CommandOptions } from '../lib/command-types.ts';

// ── Config ───────────────────────────────────────────────────────────────────

export interface BranchAgentConfig extends PatrolConfig {
  prNumber: number;
  /** Max number of Claude fix invocations before stopping (default: 20) */
  maxInvocations: number;
  /** Seconds to wait between CI polling ticks (default: 30) */
  ciPollIntervalSeconds: number;
  /** Max seconds to wait for CI to complete before attempting next fix (default: 900 = 15 min) */
  ciTimeoutSeconds: number;
}

export function buildBranchAgentConfig(
  prNumber: number,
  options: CommandOptions,
): BranchAgentConfig {
  const baseTimeout = parseIntOpt(
    options.timeout ?? process.env.PR_PATROL_TIMEOUT_MINUTES,
    15, // Shorter default for branch-agent: 15 min per session vs 30 min daemon default
  );
  return {
    repo: (process.env.PR_PATROL_REPO as string) ?? 'quantified-uncertainty/longterm-wiki',
    intervalSeconds: 60, // Unused in branch-agent, but required by PatrolConfig
    maxTurns: parseIntOpt(options.maxTurns ?? process.env.PR_PATROL_MAX_TURNS, 30),
    cooldownSeconds: 0, // Branch-agent doesn't use global cooldowns
    staleHours: 48,
    model: (options.model as string) ?? process.env.PR_PATROL_MODEL ?? 'sonnet',
    skipPerms: options.skipPerms === true || process.env.PR_PATROL_SKIP_PERMS === '1',
    once: false,
    dryRun: options.dryRun === true,
    verbose: options.verbose === true,
    reflectionInterval: 0,
    timeoutMinutes: baseTimeout,
    prNumber,
    maxInvocations: parseIntOpt(options.maxInvocations ?? 20, 20),
    ciPollIntervalSeconds: parseIntOpt(options.ciPoll ?? 30, 30),
    ciTimeoutSeconds: parseIntOpt(options.ciTimeout ?? 900, 900),
  };
}

// ── CI waiting ───────────────────────────────────────────────────────────────

type CiState = 'pending' | 'passing' | 'failing' | 'unknown';

/** Poll the PR's CI status until it resolves or times out. */
async function waitForCi(
  prNumber: number,
  repo: string,
  timeoutSeconds: number,
  pollIntervalSeconds: number,
): Promise<CiState> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  log(`  ${cl.dim}Waiting for CI to complete (up to ${Math.floor(timeoutSeconds / 60)} min)...${cl.reset}`);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalSeconds * 1000));

    try {
      const pr = await fetchSinglePr(prNumber, repo);
      if (!pr) return 'unknown';

      const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
      if (contexts.length === 0) {
        log(`  ${cl.dim}No CI checks yet — waiting...${cl.reset}`);
        continue;
      }

      const hasPending = contexts.some(
        (c) => c.conclusion === null || c.conclusion === undefined,
      );
      if (hasPending) {
        const pending = contexts.filter((c) => !c.conclusion).length;
        const total = contexts.length;
        log(`  ${cl.dim}CI: ${pending}/${total} checks still running...${cl.reset}`);
        continue;
      }

      const FAILING_CONCLUSIONS = new Set([
        'FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE',
      ]);
      const hasFailing = contexts.some((c) => c.conclusion && FAILING_CONCLUSIONS.has(c.conclusion));
      if (hasFailing) {
        const failCount = contexts.filter((c) => c.conclusion && FAILING_CONCLUSIONS.has(c.conclusion)).length;
        log(`  ${cl.red}CI: ${failCount} check(s) failing${cl.reset}`);
        return 'failing';
      }

      log(`  ${cl.green}CI: all checks passing${cl.reset}`);
      return 'passing';
    } catch (e) {
      log(`  ${cl.yellow}Warning: CI poll failed: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    }
  }

  log(`  ${cl.yellow}CI wait timed out after ${Math.floor(timeoutSeconds / 60)} min${cl.reset}`);
  return 'unknown';
}

// ── PR state helpers ─────────────────────────────────────────────────────────

function isPrMergedOrClosed(pr: GqlPrNode): boolean {
  return (pr as unknown as { state?: string }).state === 'MERGED'
    || (pr as unknown as { state?: string }).state === 'CLOSED';
}

function hasMergeableIssues(pr: GqlPrNode, staleThresholdMs: number): boolean {
  const { issues } = detectIssues(pr, staleThresholdMs);
  return issues.length > 0;
}

// ── Branch agent main loop ────────────────────────────────────────────────────

/** Run the branch agent loop for a specific PR. */
export async function runBranchAgent(config: BranchAgentConfig): Promise<void> {
  const { prNumber, repo, maxInvocations, ciPollIntervalSeconds, ciTimeoutSeconds } = config;
  const staleThresholdMs = config.staleHours * 60 * 60 * 1000;

  log(`${cl.bold}Branch Agent — PR #${prNumber}${cl.reset} (${repo})`);
  log(`  Max invocations: ${maxInvocations}, per-session timeout: ${config.timeoutMinutes}m`);

  let invocations = 0;

  // Add working label so daemon skips this PR while branch-agent is running
  try {
    await githubApi(`/repos/${repo}/issues/${prNumber}/labels`, {
      method: 'POST',
      body: { labels: [LABELS.PR_PATROL_WORKING] },
    });
    log(`  ${cl.dim}Added ${LABELS.PR_PATROL_WORKING} label${cl.reset}`);
  } catch {
    log(`  ${cl.yellow}Warning: could not add working label — daemon may compete${cl.reset}`);
  }

  const releaseLabel = async () => {
    try {
      await githubApi(`/repos/${repo}/issues/${prNumber}/labels/${encodeURIComponent(LABELS.PR_PATROL_WORKING)}`, {
        method: 'DELETE',
      });
    } catch {
      // Best-effort — stale label is non-critical
    }
  };

  // Graceful shutdown on Ctrl-C
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\n${cl.yellow}Branch agent shutting down...${cl.reset}`);
    await releaseLabel();
    await releaseCurrentClaim(repo).catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (!shuttingDown) {
    // ── Fetch current PR state ─────────────────────────────────────────────
    log(`\n${cl.bold}Cycle ${invocations + 1}/${maxInvocations}${cl.reset} — fetching PR #${prNumber}`);

    let pr: GqlPrNode | null;
    try {
      pr = await fetchSinglePr(prNumber, repo);
    } catch (e) {
      log(`${cl.red}✗ Failed to fetch PR #${prNumber}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }

    if (!pr) {
      log(`${cl.red}✗ PR #${prNumber} not found — stopping${cl.reset}`);
      break;
    }

    // Check if PR is merged/closed
    if (isPrMergedOrClosed(pr)) {
      log(`${cl.green}✓ PR #${prNumber} is merged/closed — branch agent complete${cl.reset}`);
      break;
    }

    // ── Detect issues ──────────────────────────────────────────────────────
    const { issues, botComments } = detectIssues(pr, staleThresholdMs);
    if (issues.length === 0) {
      log(`${cl.green}✓ PR #${prNumber} has no issues detected${cl.reset}`);

      // Check CI state to see if we're just waiting
      const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
      const hasPending = contexts.some((c) => !c.conclusion);
      if (hasPending) {
        log(`  ${cl.dim}CI still running — waiting...${cl.reset}`);
        await waitForCi(prNumber, repo, ciTimeoutSeconds, ciPollIntervalSeconds);
        continue;
      }

      log(`  ${cl.dim}All checks passing, no issues. Nothing to do — stopping.${cl.reset}`);
      break;
    }

    log(`  Issues detected: ${cl.yellow}${issues.join(', ')}${cl.reset}`);

    // ── Budget check ───────────────────────────────────────────────────────
    if (invocations >= maxInvocations) {
      log(`${cl.yellow}⚠ Invocation budget exhausted (${maxInvocations} sessions used)${cl.reset}`);
      log(`  Remaining issues: ${issues.join(', ')}`);
      log(`  Re-run with --max-invocations=N to continue.`);
      break;
    }

    // ── Dry run mode ───────────────────────────────────────────────────────
    if (config.dryRun) {
      log(`${cl.dim}[dry-run] Would fix: ${issues.join(', ')}${cl.reset}`);
      break;
    }

    // ── Build ScoredPr for fix ─────────────────────────────────────────────
    const detectedPr = {
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      createdAt: pr.createdAt,
      issues,
      botComments,
    };
    const scoredPr: ScoredPr = {
      ...detectedPr,
      score: computeScore(detectedPr),
    };

    // ── Fix cycle ──────────────────────────────────────────────────────────
    invocations++;
    log(`\n${cl.bold}Fix session ${invocations}${cl.reset} — ${issues.join(', ')}`);

    const budget = computeBudget(issues);
    const effectiveMaxTurns = Math.min(budget.maxTurns, config.maxTurns);
    const effectiveTimeout = Math.min(budget.timeoutMinutes, config.timeoutMinutes);
    const prompt = buildBranchAgentPrompt(scoredPr, repo, invocations, maxInvocations);

    appendJsonl(JSONL_FILE, {
      type: 'branch_agent_cycle_start',
      timestamp: new Date().toISOString(),
      pr: prNumber,
      cycle: invocations,
      issues,
    });

    const startTime = Date.now();
    let fixOutcome = 'error';
    try {
      const result = await spawnClaude(prompt, {
        ...config,
        maxTurns: effectiveMaxTurns,
        timeoutMinutes: effectiveTimeout,
      });
      const elapsedS = Math.floor((Date.now() - startTime) / 1000);

      if (result.timedOut) {
        fixOutcome = 'timeout';
        log(`${cl.yellow}⚠ Session timed out after ${effectiveTimeout}m${cl.reset} (${elapsedS}s)`);
      } else if (result.hitMaxTurns) {
        fixOutcome = 'max-turns';
        log(`${cl.yellow}⚠ Session hit max turns${cl.reset} (${elapsedS}s)`);
      } else if (result.exitCode === 0) {
        fixOutcome = 'fixed';
        log(`${cl.green}✓ Session completed${cl.reset} (${elapsedS}s)`);
      } else {
        fixOutcome = 'error';
        log(`${cl.red}✗ Session failed (exit ${result.exitCode})${cl.reset} (${elapsedS}s)`);
      }
    } catch (e) {
      fixOutcome = 'error';
      log(`${cl.red}✗ Session error: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    }

    appendJsonl(JSONL_FILE, {
      type: 'branch_agent_cycle_end',
      timestamp: new Date().toISOString(),
      pr: prNumber,
      cycle: invocations,
      outcome: fixOutcome,
    });

    // ── Wait for CI after fix ──────────────────────────────────────────────
    if (fixOutcome === 'fixed') {
      log(`\n  Waiting for CI after fix...`);
      const ciState = await waitForCi(prNumber, repo, ciTimeoutSeconds, ciPollIntervalSeconds);

      if (ciState === 'passing') {
        log(`  ${cl.green}CI passing after fix — checking for remaining issues${cl.reset}`);
        // Loop back to detect remaining issues
        continue;
      } else if (ciState === 'failing') {
        log(`  ${cl.yellow}CI still failing after fix — will retry${cl.reset}`);
        // Short pause before retrying to avoid spinning
        await new Promise((r) => setTimeout(r, 10_000));
        continue;
      } else {
        // CI timed out or unknown — continue to next cycle anyway
        log(`  ${cl.dim}CI state uncertain — continuing to next cycle${cl.reset}`);
        continue;
      }
    } else if (fixOutcome === 'timeout' || fixOutcome === 'max-turns') {
      // Session was cut short — try again if we have budget, with a short pause
      log(`  ${cl.dim}Session was cut short — pausing 30s before retrying${cl.reset}`);
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    } else {
      // Error — pause before retry
      log(`  ${cl.dim}Pausing 60s after error before retrying${cl.reset}`);
      await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }
  }

  await releaseLabel();
  await releaseCurrentClaim(repo).catch(() => {});
  log(`\n${cl.bold}Branch agent for PR #${prNumber} stopped.${cl.reset}`);
  log(`  Total invocations used: ${invocations}/${maxInvocations}`);
}
