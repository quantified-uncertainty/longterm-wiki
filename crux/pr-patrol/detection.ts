/**
 * PR Patrol — PR detection via GraphQL, issue detection, overlap detection
 */

import { githubApi, githubGraphQL, REPO } from '../lib/github.ts';
import type {
  BotComment,
  DetectedPr,
  GqlPrNode,
  GqlReviewThread,
  PatrolConfig,
  PrIssueType,
} from './types.ts';
import {
  appendJsonl,
  isRecentlyProcessed,
  JSONL_FILE,
  log,
  markProcessed,
} from './state.ts';

// ── GraphQL Queries ──────────────────────────────────────────────────────────

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
          id isResolved isOutdated path line startLine
          comments(first: 3) { nodes {
            author { login }
            body
          }}
        }}
      }
    }
  }
}`;

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
        id isResolved isOutdated path line startLine
        comments(first: 3) { nodes {
          author { login }
          body
        }}
      }}
    }
  }
}`;

// ── Bot comment detection ────────────────────────────────────────────────────

const KNOWN_BOT_LOGINS = new Set([
  'coderabbitai',
  'github-actions',
  'dependabot',
  'renovate',
]);

const ACTIONABLE_SEVERITY_RE = /🔴 Critical|🟠 Major|🟡 Minor|⚠️ Potential issue/;

/** Extract unresolved, non-outdated bot review comments from a PR node. */
export function extractBotComments(pr: GqlPrNode): BotComment[] {
  const threads = pr.reviewThreads?.nodes ?? [];
  const comments: BotComment[] = [];

  for (const thread of threads) {
    if (thread.isResolved || thread.isOutdated) continue;
    const firstComment = thread.comments.nodes[0];
    if (!firstComment?.author?.login) continue;
    if (!KNOWN_BOT_LOGINS.has(firstComment.author.login)) continue;

    comments.push({
      threadId: thread.id,
      path: thread.path,
      line: thread.line,
      startLine: thread.startLine,
      body: firstComment.body,
      author: firstComment.author.login,
    });
  }

  return comments;
}

// ── Issue detection ──────────────────────────────────────────────────────────

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

// ── PR fetching ──────────────────────────────────────────────────────────────

export async function fetchOpenPrs(config: PatrolConfig): Promise<GqlPrNode[]> {
  const [owner, name] = config.repo.split('/');
  const data = await githubGraphQL<{
    repository: { pullRequests: { nodes: GqlPrNode[] } };
  }>(PR_QUERY, { owner, name });
  const prs = data.repository.pullRequests.nodes;
  log(`Found ${prs.length} open PRs`);
  return prs;
}

/** Fetch a single PR by number. Used by `crux pr ready` for eligibility checks. */
export async function fetchSinglePr(prNumber: number): Promise<GqlPrNode | null> {
  const [owner, name] = REPO.split('/');
  try {
    const data = await githubGraphQL<{
      repository: { pullRequest: GqlPrNode | null };
    }>(SINGLE_PR_QUERY, { owner, name, number: prNumber });
    return data.repository.pullRequest;
  } catch (e) {
    log(`Warning: could not fetch PR #${prNumber}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export function detectAllPrIssuesFromNodes(
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

// ── PR Overlap Detection ────────────────────────────────────────────────────

interface PrFiles {
  prNumber: number;
  title: string;
  files: string[];
}

interface PrFileEntry {
  filename: string;
}

export async function detectPrOverlaps(config: PatrolConfig, prs: DetectedPr[]): Promise<void> {
  // Limit to first 20 PRs to avoid rate limits
  const prSubset = prs.slice(0, 20);
  if (prSubset.length < 2) return;

  log(`Checking ${prSubset.length} PRs for file overlaps...`);

  // Fetch changed files for each PR (parallelized with concurrency limit)
  const CONCURRENCY = 5;
  const prFiles: PrFiles[] = [];
  for (let i = 0; i < prSubset.length; i += CONCURRENCY) {
    const batch = prSubset.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (pr) => {
        const files = await githubApi<PrFileEntry[]>(
          `/repos/${config.repo}/pulls/${pr.number}/files?per_page=100`,
        );
        return {
          prNumber: pr.number,
          title: pr.title,
          files: files.map((f) => f.filename),
        };
      }),
    );
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled') {
        prFiles.push(result.value);
      } else {
        const pr = batch[j];
        log(`  Warning: could not fetch files for PR #${pr.number}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
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
    log('  No file overlaps detected');
    return;
  }

  log(`  Found ${overlaps.size} PR pair(s) with shared files`);

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
    const uniqueFiles = [...new Set(sharedFiles)];
    const fileList = uniqueFiles.slice(0, 10).join('\n- ');
    const moreCount = uniqueFiles.length > 10 ? ` (+${uniqueFiles.length - 10} more)` : '';

    const body = `⚠️ **PR Overlap Warning**

This PR shares ${uniqueFiles.length} file(s) with PR #${prB}:
- ${fileList}${moreCount}

Coordinate to avoid merge conflicts.

_Posted by PR Patrol — informational only._`;

    if (config.dryRun) {
      log(`  [DRY RUN] Would warn PR #${prA} and #${prB} about ${uniqueFiles.length} shared files`);
    } else {
      // Post on both PRs
      for (const prNum of [prA, prB]) {
        const otherPr = prNum === prA ? prB : prA;
        const commentBody = body.replaceAll(`PR #${prB}`, `PR #${otherPr}`);
        await githubApi(`/repos/${config.repo}/issues/${prNum}/comments`, {
          method: 'POST',
          body: { body: commentBody },
        }).catch((e) =>
          log(`  Warning: could not post overlap comment on PR #${prNum}: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    }

    markProcessed(overlapKey);
    appendJsonl(JSONL_FILE, {
      type: 'overlap_warning',
      pr_a: prA,
      pr_b: prB,
      shared_files: uniqueFiles.length,
    });
  }
}
