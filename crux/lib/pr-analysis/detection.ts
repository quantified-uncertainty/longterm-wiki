/**
 * PR Analysis — Issue detection, bot comment extraction, and PR fetching.
 *
 * All functions here are general-purpose: pure logic or simple GitHub API wrappers
 * with no daemon state, logging, or cooldown dependencies.
 */

import { getGitHubToken, githubApi, githubGraphQL, REPO } from '../github.ts';
import type {
  BlockingComment,
  BotComment,
  FreshCheckRun,
  GqlPrNode,
  PrIssueType,
  PrOverlap,
} from './types.ts';

// ── GraphQL Queries ──────────────────────────────────────────────────────────

const PR_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        id number title headRefName headRefOid mergeable mergeStateStatus isDraft createdAt updatedAt body
        author { login }
        labels(first: 20) { nodes { name } }
        commits(last: 1) { nodes { commit {
          committedDate
          statusCheckRollup {
            contexts(first: 50) { nodes {
              ... on CheckRun { name conclusion }
              ... on StatusContext { context state }
            }}
          }
        }}}
        reviewThreads(first: 50) { nodes {
          id isResolved isOutdated path line startLine
          comments(first: 3) { nodes {
            author { login }
            body
          }}
        }}
        comments(last: 20) { nodes {
          author { login __typename }
          authorAssociation
          body
          createdAt
          viewerDidAuthor
        }}
        timelineItems(last: 20, itemTypes: [CROSS_REFERENCED_EVENT]) { nodes {
          __typename
          ... on CrossReferencedEvent {
            createdAt
            source {
              __typename
              ... on PullRequest { number state }
              ... on Issue { number }
            }
          }
        }}
      }
    }
  }
}`;

const SINGLE_PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number title state headRefName headRefOid mergeable mergeStateStatus isDraft createdAt updatedAt body
      author { login }
      labels(first: 20) { nodes { name } }
      commits(last: 1) { nodes { commit {
        committedDate
        statusCheckRollup {
          contexts(first: 50) { nodes {
            ... on CheckRun { name conclusion }
            ... on StatusContext { context state }
          }}
        }
      }}}
      reviewThreads(first: 50) { nodes {
        id isResolved isOutdated path line startLine
        comments(first: 3) { nodes {
          author { login }
          body
        }}
      }}
      comments(last: 20) { nodes {
        author { login __typename }
        authorAssociation
        body
        createdAt
        viewerDidAuthor
      }}
      timelineItems(last: 20, itemTypes: [CROSS_REFERENCED_EVENT]) { nodes {
        __typename
        ... on CrossReferencedEvent {
          createdAt
          source {
            __typename
            ... on PullRequest { number state }
            ... on Issue { number }
          }
        }
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

// ── Blocking-comment extraction ──────────────────────────────────────────────

/** Author associations that indicate repo-level authority. */
const AUTHORITATIVE_ASSOCIATIONS: ReadonlySet<string> = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

/**
 * Keywords/emoji that indicate a top-level comment is a blocking concern
 * even when it comes from a CONTRIBUTOR / NONE association.
 * Case-insensitive substring match.
 */
const URGENCY_PATTERNS: readonly RegExp[] = [
  /⚠️/,
  /\bblocking\b/i,
  /\bwill break\b/i,
  /don'?t merge/i,
];

function matchesUrgencyKeyword(body: string): boolean {
  return URGENCY_PATTERNS.some((re) => re.test(body));
}

/**
 * Extract top-level comments that look blocking. A comment is blocking when:
 *   1. It was posted AFTER the last push to the PR branch
 *      (so the code hasn't been updated to address it yet), AND
 *   2. Either:
 *      a. The author is an OWNER / MEMBER / COLLABORATOR, OR
 *      b. The body contains urgency keywords (⚠️, "blocking", "will break", "don't merge")
 *
 * Pure function — no I/O.
 */
export function extractBlockingComments(pr: GqlPrNode): BlockingComment[] {
  const comments = pr.comments?.nodes ?? [];
  if (comments.length === 0) return [];

  // Determine the last-push timestamp. `committedDate` is the best proxy
  // available on the GraphQL API now that `pushedDate` is deprecated; fall
  // back to pr.updatedAt if the commit's date is missing.
  const commit = pr.commits?.nodes?.[0]?.commit;
  const lastPushIso = commit?.committedDate ?? pr.updatedAt;
  const lastPushMs = lastPushIso ? new Date(lastPushIso).getTime() : 0;

  const blocking: BlockingComment[] = [];
  for (const c of comments) {
    if (!c?.author?.login) continue;

    // Filter 0: skip patrol's own status/event markers — patrol runs under an
    // OWNER-authored token, so its own comments would otherwise trip the
    // authority filter below and produce a self-feedback infinite loop
    // (QUA-472). Match on both the visible "🤖 **PR Patrol**" prefix used by
    // event comments (enqueued, attempt, fix-complete, abandoned, timeout,
    // stuck) AND the hidden `<!-- pr-patrol-* -->` HTML marker used to
    // identify status panels. `startsWith` on the emoji prefix covers
    // every buildXxxComment() in crux/pr-patrol/comments.ts; the HTML
    // marker is `includes()`-checked because status panel bodies start with
    // the marker on their own line, not the emoji.
    const body = c.body ?? '';
    if (
      body.startsWith('\u{1F916} **PR Patrol**') ||
      body.includes('<!-- pr-patrol-')
    ) {
      continue;
    }

    // Filter 1: must be newer than the last push.
    const createdMs = new Date(c.createdAt).getTime();
    if (!Number.isFinite(createdMs)) continue;
    if (createdMs <= lastPushMs) continue;

    // Filter 2: authority OR urgency.
    const authority = AUTHORITATIVE_ASSOCIATIONS.has(c.authorAssociation);
    const urgency = matchesUrgencyKeyword(body);
    if (!authority && !urgency) continue;

    blocking.push({
      author: c.author.login,
      authorAssociation: c.authorAssociation,
      authorType: c.author.__typename ?? 'User',
      body,
      createdAt: c.createdAt,
      viewerDidAuthor: c.viewerDidAuthor ?? false,
    });
  }

  return blocking;
}

// ── Self-authored detection ──────────────────────────────────────────────────

/**
 * Return true when the PR was opened by the patrol/agent system (not a human).
 * Heuristic: the branch follows the `claude/` naming convention used by agent
 * sessions in this repo. Stored on the scan result so downstream decisions
 * (e.g. escalate instead of rebase) can short-circuit.
 */
export function isSelfAuthored(pr: GqlPrNode): boolean {
  if (!pr.headRefName) return false;
  return pr.headRefName.startsWith('claude/');
}

// ── Fresh check-runs (REST, cached per SHA) ──────────────────────────────────

interface CheckRunsResponse {
  total_count: number;
  check_runs: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    html_url?: string;
  }>;
}

interface CheckRunsCacheEntry {
  etag: string | null;
  data: FreshCheckRun[];
}

/**
 * Process-local cache of fresh check-runs keyed by SHA. Check-runs are
 * immutable once their `conclusion` is set, so caching by SHA is safe for the
 * lifetime of one patrol process. We store an ETag so we can send a
 * conditional request and get a 304 (no body) from GitHub when nothing has
 * changed, saving a round-trip and not burning rate-limit budget.
 */
const checkRunsCache = new Map<string, CheckRunsCacheEntry>();

/** Test-only: reset the SHA cache. */
export function _resetFreshCheckRunsCache(): void {
  checkRunsCache.clear();
}

/**
 * Fetch fresh check-runs for a commit via REST (bypasses GraphQL rollup
 * latency). Uses If-None-Match for conditional requests when we have a cached
 * ETag. Returns the cached value on 304.
 */
export async function fetchFreshCheckRuns(
  owner: string,
  repo: string,
  sha: string,
): Promise<FreshCheckRun[]> {
  if (!sha) return [];

  const cacheKey = `${owner}/${repo}@${sha}`;
  const cached = checkRunsCache.get(cacheKey);

  const endpoint = `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`;

  try {
    // Use the lower-level conditional fetch. githubApi() doesn't support
    // If-None-Match or 304, so we call fetch() directly here — justified
    // because this is the only path in the codebase that needs etag
    // handling for check-runs.
    const token = getGitHubToken();
    const headers: Record<string, string> = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
    };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;

    const resp = await fetch(`https://api.github.com${endpoint}`, { headers });

    if (resp.status === 304 && cached) {
      return cached.data;
    }

    if (!resp.ok) {
      // On any non-ok status, fall back to cache if we have one; otherwise
      // return empty (callers treat freshCheckRuns as advisory).
      if (cached) return cached.data;
      return [];
    }

    const body = (await resp.json()) as CheckRunsResponse;
    const etag = resp.headers.get('etag');
    const fresh: FreshCheckRun[] = body.check_runs.map((r) => ({
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      htmlUrl: r.html_url,
    }));
    checkRunsCache.set(cacheKey, { etag, data: fresh });
    return fresh;
  } catch {
    if (cached) return cached.data;
    return [];
  }
}

/**
 * Compare fresh check-runs (REST) against the stale GraphQL rollup for the
 * same commit. Returns the set of check names whose states disagree.
 * Useful for logging discrepancies — callers should prefer fresh data.
 */
export function diffCheckRunsVsRollup(
  fresh: FreshCheckRun[],
  rollupContexts: Array<{ name?: string; conclusion?: string | null; state?: string; context?: string }>,
): string[] {
  const normalize = (v: string | null | undefined): string | null =>
    v == null ? null : v.toLowerCase();
  // Index fresh runs by lowercased name so matching is case-insensitive
  // (rollup may report `Build` where REST reports `build`, etc.).
  const freshByName = new Map(
    fresh.map((r) => [r.name.toLowerCase(), normalize(r.conclusion)] as const),
  );
  const discrepancies: string[] = [];
  for (const ctx of rollupContexts) {
    const rawName = ctx.name ?? ctx.context;
    if (!rawName) continue;
    const key = rawName.toLowerCase();
    if (!freshByName.has(key)) continue;
    // Rollup's conclusion is UPPERCASE (CheckRun) or state is UPPERCASE
    // (StatusContext); fresh is always lowercase. Normalize both before
    // comparing so we don't flag false positives from mere case differences.
    const rollupConclusion = normalize(ctx.conclusion ?? ctx.state ?? null);
    const freshConclusion = freshByName.get(key) ?? null;
    if (rollupConclusion !== freshConclusion) {
      discrepancies.push(rawName);
    }
  }
  return discrepancies;
}

// ── Human-required CI checks ─────────────────────────────────────────────────

/**
 * CI checks that require a label (e.g. gate:rules-ok) and cannot be fixed
 * by code changes alone. If ALL failing checks match this list, we skip the
 * `ci-failure` issue since the bot would waste turns trying to "fix" them.
 *
 * Uses substring matching (case-insensitive) to handle variations in check
 * naming between GitHub Actions job names and check-run names.
 */
const LABEL_REQUIRED_CHECK_PATTERNS = [
  'protected paths',
  'coderabbit security gate',
];

function isLabelRequiredCheck(checkName: string): boolean {
  const lower = checkName.toLowerCase();
  return LABEL_REQUIRED_CHECK_PATTERNS.some((p) => lower.includes(p));
}

// ── Issue detection ──────────────────────────────────────────────────────────

/**
 * Pure function — detects issues on a single PR node. No I/O.
 *
 * Optional `freshCheckRuns` lets callers supplement the (sometimes stale)
 * GraphQL `statusCheckRollup` with a fresh REST snapshot for the same SHA.
 * When present, a `ci-failure` issue is only emitted if the fresh data also
 * shows a failure — this avoids the classic "GraphQL still reports failed,
 * but the follow-up push is now green" false positive.
 */
export function detectIssues(
  pr: GqlPrNode,
  staleThresholdMs: number,
  freshCheckRuns?: FreshCheckRun[],
): {
  issues: PrIssueType[];
  botComments: BotComment[];
  failingChecks: string[];
  blockingComments: BlockingComment[];
} {
  const issues: PrIssueType[] = [];

  // Merge-state: distinct handling for BLOCKED (branch-protection / required
  // reviews), BEHIND (needs rebase), DIRTY (conflicts).
  const mergeStateStatus = pr.mergeStateStatus;
  if (mergeStateStatus === 'BLOCKED') {
    issues.push('merge-blocked');
  } else if (pr.mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') {
    // BEHIND is not a conflict — it just needs a rebase, which the stale/ci
    // handlers already cover. Treat BEHIND as "no conflict"; don't emit.
    issues.push('conflict');
  }

  const contexts =
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const failingContexts = contexts.filter(
    (c) =>
      c.conclusion === 'FAILURE' ||
      c.state === 'FAILURE' ||
      c.state === 'ERROR',
  );
  const failingChecks = failingContexts
    .map((c) => c.name ?? c.context ?? 'unknown')
    .filter(Boolean);

  if (failingContexts.length > 0) {
    // Prefer fresh data when provided. The rollup can be stale by several
    // minutes after a re-run; if the fresh REST check-runs for the same SHA
    // cover every failing rollup check AND none of them are failing, suppress
    // the ci-failure emission. The scan layer logs the discrepancy separately.
    //
    // We only trust "fresh overrides" when fresh actually knows about every
    // failing rollup check — otherwise a StatusContext (e.g. CodeRabbit,
    // Vercel) that doesn't appear in check-runs would be silently ignored.
    let shouldEmitCiFailure = true;
    if (freshCheckRuns && freshCheckRuns.length > 0) {
      // Case-insensitive matching (rollup may report `Build`, REST `build`).
      const freshByName = new Map(
        freshCheckRuns.map((r) => [r.name.toLowerCase(), r] as const),
      );
      const allFailingCoveredByFresh = failingContexts.every((c) => {
        const name = (c.name ?? c.context)?.toLowerCase();
        return name != null && freshByName.has(name);
      });
      if (allFailingCoveredByFresh) {
        // Only suppress when EVERY fresh run for a failing rollup check is
        // explicitly green (completed + success). An in-progress rerun or a
        // null conclusion must NOT be treated as recovery — otherwise we hide
        // failures that haven't actually been fixed yet.
        const allFreshExplicitlyGreen = failingContexts.every((c) => {
          const name = (c.name ?? c.context)?.toLowerCase();
          if (name == null) return false;
          const run = freshByName.get(name);
          return run?.status === 'completed' && run.conclusion === 'success';
        });
        if (allFreshExplicitlyGreen) {
          shouldEmitCiFailure = false;
        }
      }
    }
    if (shouldEmitCiFailure) {
      // Check if ALL failing checks just need a label — if so, skip ci-failure
      const allLabelRequired = failingContexts.every((c) => {
        const checkName = c.name ?? c.context ?? '';
        return isLabelRequiredCheck(checkName);
      });
      if (!allLabelRequired) {
        issues.push('ci-failure');
      }
    }
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

  // Blocking top-level comments (newer than last push + authority/urgency).
  const blockingComments = extractBlockingComments(pr);
  if (blockingComments.length > 0 && isSelfAuthored(pr)) {
    issues.push('self-authored-feedback');
  }

  return { issues, botComments, failingChecks, blockingComments };
}

// ── CodeRabbit rate-limit detection ──────────────────────────────────────────

/**
 * Check if CodeRabbit's status context indicates the review was skipped
 * due to rate limiting.
 *
 * CodeRabbit adds a StatusContext with `context: "CodeRabbit"`. When rate-limited,
 * the `state` will be "PENDING" or "ERROR" rather than "SUCCESS".
 * We also check review thread comments from coderabbitai for rate-limit keywords.
 */
export function detectCodeRabbitRateLimited(pr: GqlPrNode): boolean {
  // Check StatusContext entries for CodeRabbit with non-success state
  const contexts =
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  for (const ctx of contexts) {
    if (
      ctx.context?.toLowerCase() === 'coderabbit' &&
      (ctx.state === 'PENDING' || ctx.state === 'ERROR' || ctx.state === 'FAILURE')
    ) {
      return true;
    }
  }

  // Check review thread comments for rate-limit messages from coderabbitai
  const threads = pr.reviewThreads?.nodes ?? [];
  for (const thread of threads) {
    if (thread.isResolved || thread.isOutdated) continue;
    for (const comment of thread.comments.nodes) {
      if (
        comment.author?.login === 'coderabbitai' &&
        /rate limit|review skipped/i.test(comment.body)
      ) {
        return true;
      }
    }
  }

  return false;
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
export async function detectOverlaps(prs: ReadonlyArray<{ number: number }>, repo?: string): Promise<PrOverlap[]> {
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
