/**
 * Linear In-Progress audit — classify "In Progress" issues by PR health.
 *
 * The triage-linear command flags issues by age alone. Audit correlates
 * Linear state with GitHub PR activity so the report is directly actionable:
 * which issues are genuinely active, which shipped but the state didn't update,
 * which are parent epics whose phases all landed, and which are truly orphaned.
 */

import { githubApi, REPO } from '../github.ts';
import {
  getIssueChildren,
  listIssuesByStateType,
  type LinearChildIssue,
  type LinearTriageIssue,
} from './issues.ts';

export type AuditBucket =
  | 'active'
  | 'shipped'
  | 'parent-epic'
  | 'orphan'
  | 'stuck';

export interface AuditEntry {
  issue: LinearTriageIssue;
  bucket: AuditBucket;
  reason: string;
  openPRs: Array<{ number: number; title: string; url: string }>;
  mergedPRs: Array<{ number: number; title: string; url: string; mergedAt: string }>;
  childCount: number;
  unresolvedChildren: LinearChildIssue[];
  daysInactive: number;
}

interface GhSearchItem {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  state: 'open' | 'closed';
  pull_request?: { merged_at: string | null };
}

interface GhSearchResponse {
  total_count: number;
  incomplete_results?: boolean;
  items: GhSearchItem[];
}

export const STALE_DAYS = 7;
const RESOLVED_STATE_TYPES = new Set(['completed', 'canceled']);

/**
 * GitHub auto-close keywords. Mirrors GitHub's documented set verbatim:
 * https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue
 *
 * Used by both the audit's "shipped" classifier and the verify-pr watchdog,
 * so the two stay in sync with what GitHub itself recognizes.
 */
const CLOSE_KEYWORDS =
  'close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved';

/**
 * Build a regex matching any GitHub-style auto-close reference to `id` in a
 * PR body. Accepts optional colon and any whitespace between keyword and id
 * (`Fixes QUA-1`, `Fixed: QUA-1`, `closes\nQUA-1`).
 *
 * Escapes the id for regex safety even though current Linear ids are
 * `[A-Z]+-\d+` and need no escaping — defends against future format changes.
 */
function closesReferenceRegex(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:${CLOSE_KEYWORDS})\\b\\s*:?\\s*${escaped}\\b`, 'i');
}

/**
 * Limit the number of concurrently-running async tasks. Used to cap fan-out
 * to Linear and GitHub APIs so the audit doesn't trip rate limits in teams
 * with hundreds of In Progress issues.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Search GitHub for PRs that auto-close each Linear ID, returning a
 * `id → PR list` map.
 *
 * Strategy: chunk ids into groups of ≤5 (GitHub search rejects queries with
 * >5 AND/OR/NOT operators) and fire one search per chunk. This stays well
 * under GitHub's strict 30 req/min cap on `/search/issues`, which a per-id
 * query strategy blows through immediately on a busy team.
 *
 * GitHub's search returns any PR that mentions any of the ids; client-side
 * we then verify each PR body contains an auto-close keyword reference (not
 * a bare prose mention like "follow-up to QUA-NNN"), which makes the
 * classifier robust to GitHub search's tokenization quirks and any operator
 * precedence ambiguity in the OR-with-qualifier query form.
 */
export async function searchPRsForIssues(
  ids: string[],
): Promise<Map<string, GhSearchItem[]>> {
  const result = new Map<string, GhSearchItem[]>();
  for (const id of ids) result.set(id, []);

  if (ids.length === 0) return result;

  const CHUNK = 5;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    // Repeat `repo:` and `is:pr` after each id so the qualifiers bind to the
    // whole expression regardless of GitHub's OR-vs-qualifier precedence —
    // any GitHub-search query in any documented form treats `is:pr` and
    // `repo:` as global filters; the OR connects only the bare terms.
    const orClause = chunk.join(' OR ');
    const q = `${orClause} repo:${REPO} is:pr`;
    const encoded = encodeURIComponent(q);

    let resp: GhSearchResponse;
    try {
      resp = await githubApi<GhSearchResponse>(
        `/search/issues?q=${encoded}&per_page=100`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // GitHub's /search/issues caps at 30 req/min — much tighter than the
      // core API. The audit makes one call per chunk-of-5 issues (so a team
      // with 100 active issues uses 20 of the 30/min budget per run). On
      // re-runs in quick succession, surface the rate limit clearly.
      if (/rate limit exceeded/i.test(msg)) {
        throw new Error(
          `GitHub /search/issues rate limit exceeded (30 req/min). Wait ~60s and re-run, or scope down with --bucket=<name>.`,
        );
      }
      throw new Error(`GitHub PR search failed: ${msg}`);
    }

    if (resp.total_count > resp.items.length) {
      // Surface truncation rather than silently misclassifying a SHIPPED
      // issue as orphan. 100 results per chunk-of-5 issues is a generous cap;
      // exceeding it suggests unusual cross-referencing that warrants a glance.
      console.warn(
        `[linear audit] chunk ${chunk.join(',')}: GitHub returned ${resp.items.length}/${resp.total_count} PRs (truncated).`,
      );
    }

    for (const item of resp.items) {
      const body = item.body ?? '';
      for (const id of chunk) {
        const closesRe = closesReferenceRegex(id);
        if (closesRe.test(body)) {
          result.get(id)!.push(item);
        }
      }
    }
  }

  return result;
}

export function classifyPRs(items: GhSearchItem[]): {
  openPRs: AuditEntry['openPRs'];
  mergedPRs: AuditEntry['mergedPRs'];
} {
  const openPRs: AuditEntry['openPRs'] = [];
  const mergedPRs: AuditEntry['mergedPRs'] = [];
  for (const p of items) {
    const mergedAt = p.pull_request?.merged_at ?? null;
    if (p.state === 'open') {
      openPRs.push({ number: p.number, title: p.title, url: p.html_url });
    } else if (mergedAt) {
      mergedPRs.push({
        number: p.number,
        title: p.title,
        url: p.html_url,
        mergedAt,
      });
    }
    // closed-but-not-merged PRs are ignored — they represent abandoned attempts
  }
  // Sort merged newest-first so callers can pick `[0]` and trust it.
  mergedPRs.sort((a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime());
  return { openPRs, mergedPRs };
}

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function classifyEntry(
  issue: LinearTriageIssue,
  items: GhSearchItem[],
  children: LinearChildIssue[],
): AuditEntry {
  const { openPRs, mergedPRs } = classifyPRs(items);
  const unresolvedChildren = children.filter(
    (c) => !RESOLVED_STATE_TYPES.has(c.state.type),
  );
  const daysInactive = daysSince(issue.updatedAt);

  let bucket: AuditBucket;
  let reason: string;

  if (openPRs.length > 0) {
    bucket = 'active';
    const prList = openPRs.map((p) => `#${p.number}`).join(', ');
    reason = `open PR ${prList}`;
  } else if (mergedPRs.length > 0) {
    bucket = 'shipped';
    // mergedPRs is sorted newest-first by classifyPRs.
    const latest = mergedPRs[0];
    reason = `PR #${latest.number} merged ${daysSince(latest.mergedAt)}d ago but state not updated`;
  } else if (children.length > 0 && unresolvedChildren.length === 0) {
    bucket = 'parent-epic';
    reason = `${children.length} sub-issues all resolved — safe to close`;
  } else if (daysInactive > STALE_DAYS) {
    bucket = 'orphan';
    reason = `no PR, no activity in ${daysInactive}d — move to Backlog`;
  } else {
    bucket = 'stuck';
    reason = `no PR yet (${daysInactive}d since last update)`;
  }

  return {
    issue,
    bucket,
    reason,
    openPRs,
    mergedPRs,
    childCount: children.length,
    unresolvedChildren,
    daysInactive,
  };
}

/**
 * Fetch In Progress issues and classify each.
 *
 * Concurrency: Linear children queries run with a small concurrency cap to
 * stay under Linear's GraphQL rate limits even on teams with many issues.
 * GitHub PR search runs one query per id with the same cap.
 */
export async function auditInProgress(): Promise<AuditEntry[]> {
  // Linear's `started` state type covers In Progress AND In Review. Audit
  // focuses on In Progress — In Review is naturally waiting on PR merge.
  // Hard cap at 200 to bound concurrent fan-out; teams with more than that
  // many simultaneously-active issues have bigger problems than this audit.
  const all = await listIssuesByStateType(['started'], 200);
  const issues = all.filter((i) => i.state.name === 'In Progress');

  if (issues.length === 0) return [];

  const ids = issues.map((i) => i.identifier);

  const [prMap, childrenPairs] = await Promise.all([
    searchPRsForIssues(ids),
    mapWithConcurrency(issues, 5, async (i) =>
      [i.identifier, await getIssueChildren(i.identifier)] as const,
    ),
  ]);
  const childrenMap = new Map(childrenPairs);

  return issues.map((issue) => {
    const items = prMap.get(issue.identifier) ?? [];
    const children = childrenMap.get(issue.identifier) ?? [];
    return classifyEntry(issue, items, children);
  });
}

// ---------------------------------------------------------------------------
// Watchdog: re-verify Linear state after a PR merge
// ---------------------------------------------------------------------------

/**
 * Given a PR body, return the Linear IDs it auto-closes. Mirrors GitHub's
 * full set of close keywords (`fix|fixes|fixed|close|closes|closed|resolve
 * |resolves|resolved`) plus an optional colon and any whitespace separator.
 *
 * Used by the verify-pr watchdog to know which Linear issues should be Done
 * after a merge — only IDs explicitly auto-closed are touched, never bare
 * mentions in prose.
 */
export function extractFixesIds(prBody: string): string[] {
  const re = new RegExp(
    `(?:${CLOSE_KEYWORDS})\\b\\s*:?\\s*(QUA-\\d+)`,
    'gi',
  );
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(prBody)) !== null) {
    ids.add(m[1].toUpperCase());
  }
  return [...ids];
}
