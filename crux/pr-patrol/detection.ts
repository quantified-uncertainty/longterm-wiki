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
  extractBotComments as libExtractBotComments,
  fetchOpenPrs as libFetchOpenPrs,
  fetchSinglePr as libFetchSinglePr,
  detectOverlaps as libDetectOverlaps,
} from '../lib/pr-analysis/index.ts';
import type {
  DetectedPr,
  GqlPrNode,
  PatrolConfig,
} from './types.ts';
import { LABELS } from './types.ts';
import { ADVISORY_ISSUES } from '../lib/pr-analysis/types.ts';
import { ANY_WORKING_LABELS } from '../lib/labels.ts';
import {
  appendJsonl,
  cl,
  isRecentlyProcessed,
  JSONL_FILE,
  log,
  markProcessed,
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

export function detectAllPrIssuesFromNodes(
  prs: GqlPrNode[],
  config: PatrolConfig,
): DetectedPr[] {
  const staleThresholdMs = Date.now() - config.staleHours * 3600 * 1000;

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
      const { issues: allIssues, botComments, failingChecks } = libDetectIssues(pr, staleThresholdMs);
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
      };
    })
    .filter((pr) => pr.issues.length > 0);
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
