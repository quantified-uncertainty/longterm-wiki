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
  closed_at: string | null;
}

interface GhSearchResponse {
  total_count: number;
  items: GhSearchItem[];
}

const STALE_DAYS = 7;
const RESOLVED_STATE_TYPES = new Set(['completed', 'canceled']);

/**
 * Search GitHub for PRs referencing any of the given Linear IDs in their body
 * or title. One search call covers all IDs at once — GitHub's search API lets
 * you OR terms together, so we can audit 30 issues with a single request.
 *
 * Falls back to per-issue search if the combined query exceeds GitHub's limit.
 */
async function searchPRsForIssues(
  ids: string[],
): Promise<Map<string, GhSearchItem[]>> {
  const result = new Map<string, GhSearchItem[]>();
  for (const id of ids) result.set(id, []);

  if (ids.length === 0) return result;

  // GitHub's search API rejects queries with >5 AND/OR/NOT operators.
  // 5 ORs means 6 terms max — use 5 to stay safely under the limit.
  const CHUNK = 5;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
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
      throw new Error(`GitHub PR search failed: ${msg}`);
    }

    for (const item of resp.items) {
      const body = item.body ?? '';
      for (const id of chunk) {
        // Only count PRs that actually close the issue via Fixes/Closes/Resolves.
        // A bare mention in prose (e.g. "follow-up to QUA-NNN") is not a close.
        const closesRe = new RegExp(`(?:Fixes|Closes|Resolves)\\s+${id}\\b`, 'i');
        if (closesRe.test(body)) {
          result.get(id)!.push(item);
        }
      }
    }
  }

  return result;
}

function classifyPRs(items: GhSearchItem[]): {
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
  return { openPRs, mergedPRs };
}

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/**
 * Fetch In Progress issues and classify each.
 *
 * Concurrency: Linear children queries run in parallel (small, fast).
 * GitHub PR search is batched into chunks of 15 IDs.
 */
export async function auditInProgress(): Promise<AuditEntry[]> {
  // Use state type "started" which includes In Progress AND In Review.
  // Audit focuses on In Progress — In Review is naturally waiting on PR merge.
  const all = await listIssuesByStateType(['started'], 100);
  const issues = all.filter((i) => i.state.name === 'In Progress');

  if (issues.length === 0) return [];

  const ids = issues.map((i) => i.identifier);

  const [prMap, childrenPairs] = await Promise.all([
    searchPRsForIssues(ids),
    Promise.all(
      issues.map(async (i) => [i.identifier, await getIssueChildren(i.identifier)] as const),
    ),
  ]);
  const childrenMap = new Map(childrenPairs);

  return issues.map((issue) => {
    const items = prMap.get(issue.identifier) ?? [];
    const { openPRs, mergedPRs } = classifyPRs(items);
    const children = childrenMap.get(issue.identifier) ?? [];
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
      const latest = mergedPRs
        .slice()
        .sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1))[0];
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
  });
}

// ---------------------------------------------------------------------------
// Watchdog: re-verify Linear state after a PR merge
// ---------------------------------------------------------------------------

/**
 * Given a merged PR, return the Linear IDs it closes (from `Fixes QUA-NNN`
 * style lines) and their current state. Used by the post-merge watchdog.
 */
export function extractFixesIds(prBody: string): string[] {
  const re = /(?:Fixes|Closes|Resolves)\s+(QUA-\d+)/gi;
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(prBody)) !== null) {
    ids.add(m[1].toUpperCase());
  }
  return [...ids];
}
