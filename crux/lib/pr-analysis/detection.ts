/**
 * PR Analysis — Issue detection, bot comment extraction, and PR fetching.
 *
 * All functions here are general-purpose: pure logic or simple GitHub API wrappers
 * with no daemon state, logging, or cooldown dependencies.
 */

import { githubApi, githubGraphQL, REPO } from '../github.ts';
import type {
  BotComment,
  GqlPrNode,
  PrIssueType,
  PrOverlap,
} from './types.ts';

// ── GraphQL Queries ──────────────────────────────────────────────────────────

const PR_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        id number title headRefName headRefOid mergeable isDraft createdAt updatedAt body
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
      number title headRefName headRefOid mergeable isDraft createdAt updatedAt body
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

/** Extract unresolved, non-outdated bot review comments from a PR node. Pure function. */
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

/** Pure function — detects issues on a single PR node. No I/O. */
export function detectIssues(
  pr: GqlPrNode,
  staleThresholdMs: number,
): { issues: PrIssueType[]; botComments: BotComment[] } {
  const issues: PrIssueType[] = [];

  if (pr.mergeable === 'CONFLICTING') issues.push('conflict');

  const contexts =
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
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
  if (!/(Closes|Fixes|Resolves) #\d/i.test(body)) issues.push('missing-issue-ref');

  const updatedMs = new Date(pr.updatedAt || pr.createdAt).getTime();
  if (updatedMs < staleThresholdMs) issues.push('stale');

  const botComments = extractBotComments(pr);
  if (botComments.length > 0) {
    const hasActionable = botComments.some((c) => ACTIONABLE_SEVERITY_RE.test(c.body));
    issues.push(hasActionable ? 'bot-review-major' : 'bot-review-nitpick');
  }

  return { issues, botComments };
}

// ── PR fetching ──────────────────────────────────────────────────────────────

/** Fetch all open PRs via GraphQL. No logging — callers handle their own. */
export async function fetchOpenPrs(repo?: string): Promise<GqlPrNode[]> {
  const r = repo ?? REPO;
  const [owner, name] = r.split('/');
  const data = await githubGraphQL<{
    repository: { pullRequests: { nodes: GqlPrNode[] } };
  }>(PR_QUERY, { owner, name });
  return data.repository.pullRequests.nodes;
}

/** Fetch a single PR by number via GraphQL. Returns null on failure. */
export async function fetchSinglePr(prNumber: number, repo?: string): Promise<GqlPrNode | null> {
  const r = repo ?? REPO;
  const [owner, name] = r.split('/');
  try {
    const data = await githubGraphQL<{
      repository: { pullRequest: GqlPrNode | null };
    }>(SINGLE_PR_QUERY, { owner, name, number: prNumber });
    return data.repository.pullRequest;
  } catch {
    return null;
  }
}

// ── Overlap detection ────────────────────────────────────────────────────────

interface PrFileEntry {
  filename: string;
}

/**
 * Detect file-level overlaps across open PRs. Read-only — returns data,
 * does not post comments or track state. Callers decide what to do with results.
 */
export async function detectOverlaps(prs: GqlPrNode[], repo?: string): Promise<PrOverlap[]> {
  const r = repo ?? REPO;
  const prSubset = prs.slice(0, 20);
  if (prSubset.length < 2) return [];

  // Fetch changed files for each PR (parallelized with concurrency limit)
  const CONCURRENCY = 5;
  const prFiles: Array<{ prNumber: number; files: string[] }> = [];
  for (let i = 0; i < prSubset.length; i += CONCURRENCY) {
    const batch = prSubset.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (pr) => {
        const files = await githubApi<PrFileEntry[]>(
          `/repos/${r}/pulls/${pr.number}/files?per_page=100`,
        );
        return { prNumber: pr.number, files: files.map((f) => f.filename) };
      }),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') {
        prFiles.push(result.value);
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
  const overlaps = new Map<string, string[]>();
  for (const [file, prNums] of fileMap) {
    if (prNums.length < 2) continue;
    for (let i = 0; i < prNums.length; i++) {
      for (let j = i + 1; j < prNums.length; j++) {
        const key = `${Math.min(prNums[i], prNums[j])}-${Math.max(prNums[i], prNums[j])}`;
        const existing = overlaps.get(key) ?? [];
        existing.push(file);
        overlaps.set(key, existing);
      }
    }
  }

  return [...overlaps.entries()].map(([key, files]) => {
    const [a, b] = key.split('-').map(Number);
    return { prA: a, prB: b, sharedFiles: [...new Set(files)] };
  });
}
