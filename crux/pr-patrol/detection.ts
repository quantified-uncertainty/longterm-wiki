/**
 * PR Patrol — PR detection wrappers (daemon-specific)
 *
 * Pure analysis functions (detectIssues, extractBotComments, fetchOpenPrs, fetchSinglePr)
 * live in crux/lib/pr-analysis/. This module adds daemon concerns:
 *   - Filtering by labels/draft status
 *   - Logging
 *   - Cooldown-aware overlap detection with GitHub comment posting
 *   - Stacked branch detection (shared commit filtering)
 */

import { githubApi } from '../lib/github.ts';
import {
  detectIssues as libDetectIssues,
  diffCheckRunsVsRollup,
  extractBotComments as libExtractBotComments,
  extractBlockingComments as libExtractBlockingComments,
  isSelfAuthored as libIsSelfAuthored,
  fetchFreshCheckRuns as libFetchFreshCheckRuns,
  fetchOpenPrs as libFetchOpenPrs,
  fetchSinglePr as libFetchSinglePr,
  detectOverlaps as libDetectOverlaps,
} from '../lib/pr-analysis/index.ts';
import type {
  DetectedPr,
  FreshCheckRun,
  GqlPrNode,
  PatrolConfig,
} from './types.ts';
import { LABELS } from './types.ts';
import { ADVISORY_ISSUES } from '../lib/pr-analysis/types.ts';
import { ANY_WORKING_LABELS } from '../lib/labels.ts';
import {
  appendJsonl,
  appendJsonlLocked,
  cl,
  clearAbandoned,
  clearPendingCICheck,
  clearTotalFixAttempts,
  countConsecutiveCycles,
  getAbandonedSha,
  isAbandoned,
  isPendingCICheck,
  isRecentlyProcessed,
  JSONL_FILE,
  log,
  markAbandoned,
  markProcessed,
  recordFailure,
  resetFailCount,
  stateFingerprint,
} from './state.ts';

// ── Bot / release PR skip lists ──────────────────────────────────────────────

/** PR authors that are bots — their PRs never reference issues. */
const SKIP_AUTHORS = new Set([
  'dependabot[bot]',
  'renovate[bot]',
  'github-actions[bot]',
]);

/** Branch prefixes whose PRs should be skipped (e.g. dependabot/, release/). */
const SKIP_BRANCH_PREFIXES = [
  'dependabot/',
  'renovate/',
  'release/',
];

// ── Re-exports for backward compatibility ────────────────────────────────────

export { libExtractBotComments as extractBotComments };
export { libExtractBlockingComments as extractBlockingComments };
export { libIsSelfAuthored as isSelfAuthored };
export { libFetchFreshCheckRuns as fetchFreshCheckRuns };
export { libDetectIssues as detectIssues };

// ── PR fetching (daemon wrappers with logging) ───────────────────────────────

export async function fetchOpenPrs(config: PatrolConfig): Promise<GqlPrNode[]> {
  const prs = await libFetchOpenPrs(config.repo);
  log(`Found ${cl.bold}${prs.length}${cl.reset} open PRs`);
  return prs;
}

export async function fetchSinglePr(prNumber: number): Promise<GqlPrNode | null> {
  const pr = await libFetchSinglePr(prNumber);
  if (!pr) {
    log(`${cl.yellow}Warning: could not fetch PR #${prNumber}${cl.reset}`);
  }
  return pr;
}

// ── Daemon-specific: filter PRs by labels/draft and detect issues ────────────

/**
 * Fetch fresh check-runs for each PR's head SHA and return them keyed by OID.
 * Used by daemon entry points before calling `detectAllPrIssuesFromNodes` so
 * stale-rollup false positives are avoided automatically.
 */
export async function fetchFreshCheckRunsByOid(
  prs: GqlPrNode[],
  config: PatrolConfig,
): Promise<Map<string, FreshCheckRun[]>> {
  const result = new Map<string, FreshCheckRun[]>();
  if (prs.length === 0) return result;
  const [owner, repo] = config.repo.split('/');
  if (!owner || !repo) return result;
  const seen = new Set<string>();
  await Promise.all(
    prs
      .filter((pr) => pr.headRefOid && !seen.has(pr.headRefOid) && seen.add(pr.headRefOid))
      .map(async (pr) => {
        try {
          const runs = await libFetchFreshCheckRuns(owner, repo, pr.headRefOid);
          result.set(pr.headRefOid, runs);
        } catch (e: unknown) {
          // Fresh fetch is advisory — on failure, detectIssues falls back to rollup.
          log(`  ${cl.dim}fetchFreshCheckRuns failed for PR #${pr.number}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
        }
      }),
  );
  return result;
}

/**
 * Async entry point for daemon callers: fetches fresh check-runs for every PR
 * up front so detection never silently falls back to the stale rollup. Test
 * code can keep using `detectAllPrIssuesFromNodes` directly with a fake map.
 */
export async function detectAllPrIssues(
  prs: GqlPrNode[],
  config: PatrolConfig,
): Promise<DetectedPr[]> {
  const freshCheckRunsByOid = await fetchFreshCheckRunsByOid(prs, config);
  return detectAllPrIssuesFromNodes(prs, config, freshCheckRunsByOid);
}

export function detectAllPrIssuesFromNodes(
  prs: GqlPrNode[],
  config: PatrolConfig,
  /**
   * Optional map of headRefOid → fresh check-runs. When provided, detectIssues
   * uses the fresh data to avoid stale-rollup false positives, and a
   * discrepancy between fresh and rollup is logged. Production daemon entry
   * points should use `detectAllPrIssues` (async) which builds this map via
   * `fetchFreshCheckRunsByOid`; tests and one-shot callers can omit it.
   */
  freshCheckRunsByOid?: Map<string, FreshCheckRun[]>,
): DetectedPr[] {
  const staleThresholdMs = Date.now() - config.staleHours * 3600 * 1000;

  // Check for new pushes on abandoned PRs — clear abandoned state if HEAD SHA changed.
  // Also update the stored SHA for abandoned PRs that don't have one yet (backward compat).
  for (const pr of prs) {
    if (!isAbandoned(pr.number)) continue;
    const abandonedSha = getAbandonedSha(pr.number);
    if (abandonedSha && pr.headRefOid && abandonedSha !== pr.headRefOid) {
      clearAbandoned(pr.number);
      clearTotalFixAttempts(pr.number);
      log(`  PR #${pr.number}: new push detected (${abandonedSha.slice(0, 8)} → ${pr.headRefOid.slice(0, 8)}) — cleared abandoned state + fix attempts`);
    } else if (!abandonedSha && pr.headRefOid) {
      // Backfill: write the current SHA so future pushes can be detected
      markAbandoned(pr.number, pr.headRefOid);
    }
  }

  // Check pending CI checks before filtering.
  // PRs that were "fixed" in a previous cycle need their CI status verified.
  for (const pr of prs) {
    if (!isPendingCICheck(pr.number)) continue;
    const fresh = freshCheckRunsByOid?.get(pr.headRefOid);
    const { issues: currentIssues } = libDetectIssues(pr, staleThresholdMs, fresh);
    const hasCiFailure = currentIssues.includes('ci-failure');
    if (!hasCiFailure) {
      // CI passed — the fix worked, reset the fail counter
      resetFailCount(pr.number);
      clearPendingCICheck(pr.number);
      log(`  PR #${pr.number}: CI passed after fix — fail counter reset`);
    } else {
      // CI still failing — the fix didn't work, increment fail counter
      recordFailure(pr.number);
      clearPendingCICheck(pr.number);
      log(`  PR #${pr.number}: CI still failing after fix — incrementing fail counter`);
    }
  }

  return prs
    .filter((pr) => {
      const labels = pr.labels.nodes.map((l) => l.name);
      if (ANY_WORKING_LABELS.some((wl) => labels.includes(wl))) return false;
      // Skip draft PRs — they're not ready for automated fixes
      if (pr.isDraft) return false;
      // Skip bot-authored PRs — they don't reference issues and waste cycles
      if (pr.author?.login && SKIP_AUTHORS.has(pr.author.login)) {
        if (config.verbose) {
          log(`  ${cl.dim}Skipping PR #${pr.number} — bot author: ${pr.author.login}${cl.reset}`);
        }
        return false;
      }
      // Skip release/dependency branches — they inherently lack issue refs
      if (SKIP_BRANCH_PREFIXES.some((prefix) => pr.headRefName.startsWith(prefix))) {
        if (config.verbose) {
          log(`  ${cl.dim}Skipping PR #${pr.number} — skip-listed branch: ${pr.headRefName}${cl.reset}`);
        }
        return false;
      }
      return true;
    })
    .map((pr) => {
      const fresh = freshCheckRunsByOid?.get(pr.headRefOid);

      // Log any discrepancy between fresh check-runs and the (possibly stale)
      // rollup so operators can track false-positive rates.
      if (fresh && fresh.length > 0) {
        const rollupContexts =
          pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
        const diff = diffCheckRunsVsRollup(fresh, rollupContexts);
        if (diff.length > 0) {
          log(`  ${cl.dim}PR #${pr.number}: rollup vs fresh check-runs disagree on: ${diff.join(', ')} (using fresh)${cl.reset}`);
        }
      }

      const { issues: allIssues, botComments, failingChecks, blockingComments } =
        libDetectIssues(pr, staleThresholdMs, fresh);
      const advisoryIssues = allIssues.filter((i) => ADVISORY_ISSUES.has(i));
      const fixableIssues = allIssues.filter((i) => !ADVISORY_ISSUES.has(i));
      if (advisoryIssues.length > 0) {
        log(`  PR #${pr.number}: advisory issues (skipped): ${advisoryIssues.join(', ')}`);
      }
      return {
        number: pr.number,
        title: pr.title,
        branch: pr.headRefName,
        createdAt: pr.createdAt,
        issues: fixableIssues,
        botComments,
        labels: pr.labels.nodes.map((l) => l.name),
        failingChecks: failingChecks.length > 0 ? failingChecks : undefined,
        blockingComments: blockingComments.length > 0 ? blockingComments : undefined,
        freshCheckRuns: fresh,
        mergeStateStatus: pr.mergeStateStatus,
        isSelfAuthored: libIsSelfAuthored(pr),
      };
    })
    .filter((pr) => pr.issues.length > 0);
}

// ── Stuck-cycle detection ────────────────────────────────────────────────────

/**
 * Minimum consecutive cycles (inclusive of current) before a PR is flagged as
 * stuck. At this point the coordinator escalation path runs instead of another
 * fix dispatch.
 */
export const STUCK_CYCLE_THRESHOLD = 3;

/**
 * Collapse the status-check rollup into a single conclusion string suitable
 * for fingerprinting. We want something that changes when a previously-failing
 * check passes (or vice versa) but tolerates minor flux in pending states.
 *
 * Returns one of: 'FAIL' | 'PENDING' | 'PASS' | 'NONE'.
 */
export function computeRollupConclusion(pr: GqlPrNode): string {
  const contexts =
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  if (contexts.length === 0) return 'NONE';

  const hasFailure = contexts.some(
    (c) =>
      c.conclusion === 'FAILURE' ||
      c.conclusion === 'CANCELLED' ||
      c.state === 'FAILURE' ||
      c.state === 'ERROR',
  );
  if (hasFailure) return 'FAIL';

  const hasPending = contexts.some(
    (c) =>
      (c.conclusion === null || c.conclusion === undefined) &&
      c.state !== 'SUCCESS',
  );
  if (hasPending) return 'PENDING';

  return 'PASS';
}

/**
 * Annotate detected PRs with stuck-cycle metadata.
 *
 * For each detected PR this function:
 *   1. Builds a coarse state fingerprint that deliberately EXCLUDES headSha
 *      (so pushes without real progress still count as stuck).
 *   2. Counts consecutive prior matching snapshots in the JSONL log.
 *   3. Persists the current snapshot (locked append).
 *   4. When `(prior + 1) >= STUCK_CYCLE_THRESHOLD`, attaches `stuckCycles`,
 *      `stuckReason`, and pushes `'stuck'` onto `pr.issues` so downstream
 *      scoring + execution routes it to the coordinator escalation path.
 *
 * Writes are best-effort: any I/O error is logged but never thrown — the
 * main scan must not fail just because we can't record a snapshot.
 */
export async function applyStuckCycleDetection(
  detected: DetectedPr[],
  prNodes: GqlPrNode[],
  /**
   * Override the JSONL path — primarily for tests so they don't pollute the
   * real patrol log. Defaults to the canonical JSONL_FILE.
   */
  jsonlFile: string = JSONL_FILE,
): Promise<void> {
  // Index raw GqlPrNode by number so we can read headRefOid + rollup contexts.
  const nodeByNumber = new Map<number, GqlPrNode>();
  for (const pr of prNodes) nodeByNumber.set(pr.number, pr);

  for (const pr of detected) {
    const node = nodeByNumber.get(pr.number);
    if (!node) continue;

    const mergeable = node.mergeable;
    const rollupConclusion = computeRollupConclusion(node);
    const blockingCommentCount = pr.blockingComments?.length ?? 0;
    const fingerprint = stateFingerprint({
      mergeable,
      rollupConclusion,
      blockingCommentCount,
    });

    let priorMatching = 0;
    try {
      priorMatching = countConsecutiveCycles(pr.number, fingerprint, jsonlFile);
    } catch (e) {
      log(`  ${cl.yellow}Warning: could not count prior cycles for PR #${pr.number}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    }
    const stuckCycles = priorMatching + 1; // include the current cycle

    // Persist snapshot with a file lock so concurrent patrol runs don't
    // interleave writes. Best-effort — any failure falls back to an
    // unlocked append inside appendJsonlLocked.
    await appendJsonlLocked(jsonlFile, {
      type: 'pr_cycle_snapshot',
      pr_num: pr.number,
      fingerprint,
      head_sha: node.headRefOid,
      mergeable,
      rollup_conclusion: rollupConclusion,
      blocking_comment_count: blockingCommentCount,
    }).catch((e: unknown) => {
      log(`  ${cl.yellow}Warning: could not record cycle snapshot for PR #${pr.number}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    });

    if (stuckCycles >= STUCK_CYCLE_THRESHOLD) {
      pr.stuckCycles = stuckCycles;
      pr.stuckReason = fingerprint;
      if (!pr.issues.includes('stuck')) pr.issues.push('stuck');
      log(`  ${cl.yellow}PR #${pr.number}: stuck for ${stuckCycles} cycles (fingerprint=${fingerprint}) — escalating${cl.reset}`);
    } else if (stuckCycles >= 2) {
      // Not yet at threshold but trending — annotate so the fix prompt can
      // warn the agent.
      pr.stuckCycles = stuckCycles;
      pr.stuckReason = fingerprint;
    }
  }
}

// ── Stacked branch detection helpers ─────────────────────────────────────────

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
    log(`  ${cl.yellow}Warning: could not fetch commits for PR #${prNumber}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
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
    log(`  ${cl.yellow}Warning: could not fetch files for commit ${sha.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
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

// ── Daemon-specific: overlap detection with comment posting ──────────────────

export async function detectPrOverlaps(config: PatrolConfig, prs: DetectedPr[]): Promise<void> {
  if (prs.length < 2) return;

  log(`${cl.dim}Checking ${Math.min(prs.length, 20)} PRs for file overlaps...${cl.reset}`);

  // detectOverlaps only needs { number } — pass narrow objects
  const overlaps = await libDetectOverlaps(
    prs.map((pr) => ({ number: pr.number })),
    config.repo,
  );

  if (overlaps.length === 0) {
    log(`  ${cl.dim}No file overlaps detected${cl.reset}`);
    return;
  }

  log(`  ${cl.yellow}Found ${overlaps.length} PR pair(s) with shared files${cl.reset}`);

  // Cache commit SHAs across pairs to avoid duplicate fetches
  const commitCache = new Map<number, string[]>();

  // Post warning comments (respecting cooldown)
  for (const overlap of overlaps) {
    const overlapKey = `overlap-${overlap.prA}-${overlap.prB}`;
    if (isRecentlyProcessed(overlapKey, config.cooldownSeconds * 4)) {
      // Use 4× the normal cooldown since overlap warnings are informational
      continue;
    }

    let uniqueFiles = overlap.sharedFiles;

    // Check if the overlap is explained by shared commits (stacked branches)
    const { genuineOverlap, sharedCommitCount } = await filterSharedCommitFiles(
      config, overlap.prA, overlap.prB, uniqueFiles, commitCache,
    );

    if (sharedCommitCount > 0 && genuineOverlap.length === 0) {
      log(`  PRs #${overlap.prA} and #${overlap.prB}: all ${uniqueFiles.length} overlapping file(s) from ${sharedCommitCount} shared commit(s) (stacked branches) — skipping warning`);
      markProcessed(overlapKey);
      appendJsonl(JSONL_FILE, {
        type: 'overlap_skipped_stacked',
        pr_a: overlap.prA,
        pr_b: overlap.prB,
        shared_files: uniqueFiles.length,
        shared_commits: sharedCommitCount,
      });
      continue;
    }

    if (sharedCommitCount > 0) {
      log(`  PRs #${overlap.prA} and #${overlap.prB}: ${uniqueFiles.length - genuineOverlap.length} file(s) from shared commits, ${genuineOverlap.length} genuine overlap(s)`);
      uniqueFiles = genuineOverlap;
    }

    const fileList = uniqueFiles.slice(0, 10).join('\n- ');
    const moreCount = uniqueFiles.length > 10 ? ` (+${uniqueFiles.length - 10} more)` : '';
    const stackedNote = sharedCommitCount > 0
      ? `\n\n_Note: These PRs share ${sharedCommitCount} commit(s) (stacked branches). Only independently-modified files are listed above._`
      : '';

    const body = `⚠️ **PR Overlap Warning**

This PR shares ${uniqueFiles.length} file(s) with PR #${overlap.prB}:
- ${fileList}${moreCount}

Coordinate to avoid merge conflicts.${stackedNote}

_Posted by PR Patrol — informational only._`;

    if (config.dryRun) {
      log(`  ${cl.dim}[DRY RUN] Would warn PR #${overlap.prA} and #${overlap.prB} about ${uniqueFiles.length} shared files${cl.reset}`);
    } else {
      // Post on both PRs — only mark processed if both succeed
      let postedCount = 0;
      for (const prNum of [overlap.prA, overlap.prB]) {
        const otherPr = prNum === overlap.prA ? overlap.prB : overlap.prA;
        const commentBody = body.replaceAll(`PR #${overlap.prB}`, `PR #${otherPr}`);
        const ok = await githubApi(`/repos/${config.repo}/issues/${prNum}/comments`, {
          method: 'POST',
          body: { body: commentBody },
        }).then(() => true).catch((e) => {
          log(`  ${cl.yellow}Warning: could not post overlap comment on PR #${prNum}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
          return false;
        });
        if (ok) postedCount++;
      }
      if (postedCount < 2) continue; // Don't start cooldown if a comment failed to post
    }

    markProcessed(overlapKey);
    appendJsonl(JSONL_FILE, {
      type: 'overlap_warning',
      pr_a: overlap.prA,
      pr_b: overlap.prB,
      shared_files: uniqueFiles.length,
      shared_commits: sharedCommitCount,
    });
  }
}
