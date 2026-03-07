/**
 * PR Patrol — PR detection wrappers (daemon-specific)
 *
 * Pure analysis functions (detectIssues, extractBotComments, fetchOpenPrs, fetchSinglePr)
 * live in crux/lib/pr-analysis/. This module adds daemon concerns:
 *   - Filtering by labels/draft status
 *   - Logging
 *   - Cooldown-aware overlap detection with GitHub comment posting
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
import {
  appendJsonl,
  isRecentlyProcessed,
  JSONL_FILE,
  log,
  markProcessed,
} from './state.ts';

// ── Re-exports for backward compatibility ────────────────────────────────────

export { libExtractBotComments as extractBotComments };
export { libDetectIssues as detectIssues };

// ── PR fetching (daemon wrappers with logging) ───────────────────────────────

export async function fetchOpenPrs(config: PatrolConfig): Promise<GqlPrNode[]> {
  const prs = await libFetchOpenPrs(config.repo);
  log(`Found ${prs.length} open PRs`);
  return prs;
}

export async function fetchSinglePr(prNumber: number): Promise<GqlPrNode | null> {
  const pr = await libFetchSinglePr(prNumber);
  if (!pr) {
    log(`Warning: could not fetch PR #${prNumber}`);
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
      if (labels.includes(LABELS.AGENT_WORKING)) return false;
      // Skip draft PRs — they're not ready for automated fixes
      if (pr.isDraft) return false;
      return true;
    })
    .map((pr) => {
      const { issues, botComments } = libDetectIssues(pr, staleThresholdMs);
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

// ── Daemon-specific: overlap detection with comment posting ──────────────────

export async function detectPrOverlaps(config: PatrolConfig, prs: DetectedPr[]): Promise<void> {
  if (prs.length < 2) return;

  log(`Checking ${Math.min(prs.length, 20)} PRs for file overlaps...`);

  // Use GqlPrNode-shaped objects for the lib function
  const prNodes: GqlPrNode[] = prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    headRefName: pr.branch,
    headRefOid: '',
    mergeable: '',
    isDraft: false,
    createdAt: pr.createdAt,
    updatedAt: pr.createdAt,
    body: null,
    labels: { nodes: [] },
    commits: { nodes: [] },
  }));

  const overlaps = await libDetectOverlaps(prNodes, config.repo);

  if (overlaps.length === 0) {
    log('  No file overlaps detected');
    return;
  }

  log(`  Found ${overlaps.length} PR pair(s) with shared files`);

  // Post warning comments (respecting cooldown)
  for (const overlap of overlaps) {
    const overlapKey = `overlap-${overlap.prA}-${overlap.prB}`;
    if (isRecentlyProcessed(overlapKey, config.cooldownSeconds * 4)) {
      // Use 4× the normal cooldown since overlap warnings are informational
      continue;
    }

    const uniqueFiles = overlap.sharedFiles;
    const fileList = uniqueFiles.slice(0, 10).join('\n- ');
    const moreCount = uniqueFiles.length > 10 ? ` (+${uniqueFiles.length - 10} more)` : '';

    const body = `⚠️ **PR Overlap Warning**

This PR shares ${uniqueFiles.length} file(s) with PR #${overlap.prB}:
- ${fileList}${moreCount}

Coordinate to avoid merge conflicts.

_Posted by PR Patrol — informational only._`;

    if (config.dryRun) {
      log(`  [DRY RUN] Would warn PR #${overlap.prA} and #${overlap.prB} about ${uniqueFiles.length} shared files`);
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
          log(`  Warning: could not post overlap comment on PR #${prNum}: ${e instanceof Error ? e.message : String(e)}`);
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
    });
  }
}
