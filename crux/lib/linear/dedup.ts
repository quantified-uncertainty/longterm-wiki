/**
 * Dedup helpers for `crux linear start`.
 *
 * Detects whether another session has already claimed a Linear issue, so
 * that two agents don't race to implement the same ticket (QUA-406). The
 * check has two independent signals:
 *
 * 1. Recent "🤖 Claude Code starting work" comments on the Linear issue
 *    from a different slot, not yet superseded by a "finished work" comment.
 * 2. Open PRs in the wiki repo whose title or body mentions the Linear ID.
 *
 * Either signal is sufficient to block the `start` call. Users can override
 * with `--force` (see `crux linear start --force`). Both checks fail-open
 * on API errors: if GitHub or Linear is unreachable, we let the session
 * proceed rather than blocking on a transient glitch. The downside of a
 * rare missed collision is less bad than blocking all sessions when the
 * APIs hiccup.
 */

import { githubApi, REPO } from '../github.ts';
import { getComments, type LinearComment } from './issues.ts';
import type { SessionContext } from '../session/session-context.ts';

// 24-hour window for considering a start comment "recent." Anything older
// is treated as stale and ignored — if a session has been claimed for >24h
// without completing, it's probably abandoned or in need of manual review,
// and blocking new claims on it would be worse than letting them through.
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RecentStartClaim {
  /** The original comment body (for display in error messages). */
  body: string;
  /** ISO timestamp when the comment was posted. */
  createdAt: string;
  /** Branch parsed from `**Branch:** \`<name>\``, or null if not present. */
  branch: string | null;
  /** Slot parsed from `**Slot:** a<N>`, or null if not present. */
  slot: string | null;
}

const START_COMMENT_MARKER = /🤖\s*Claude Code starting work/;
const FINISH_COMMENT_MARKER = /🤖\s*Claude Code finished work/;
const BRANCH_LINE = /\*\*Branch:\*\*\s*`([^`]+)`/;
const SLOT_LINE = /\*\*Slot:\*\*\s*(a\d+)/;

function parseStartClaim(comment: LinearComment): RecentStartClaim | null {
  if (!START_COMMENT_MARKER.test(comment.body)) return null;
  const branchMatch = comment.body.match(BRANCH_LINE);
  const slotMatch = comment.body.match(SLOT_LINE);
  return {
    body: comment.body,
    createdAt: comment.createdAt,
    branch: branchMatch ? branchMatch[1] : null,
    slot: slotMatch ? slotMatch[1] : null,
  };
}

/**
 * Fetch recent start-work comments that represent unresolved claims by
 * another session. "Unresolved" means: posted in the last 24h, from a
 * different slot than ours, and not followed by a "finished work" comment
 * from the same session.
 *
 * Same-slot re-runs (init crash recovery, resume) are not blocked — it's
 * the same user reclaiming their own workspace. Cross-slot starts are the
 * collision pattern we care about (QUA-406: a9 vs a16 on the same machine).
 *
 * Fail-open: returns an empty array if the Linear API is unreachable.
 */
export async function findActiveClaimsByOthers(
  linearId: string,
  ctx: SessionContext,
  nowMs: number = Date.now(),
): Promise<RecentStartClaim[]> {
  let comments: LinearComment[];
  try {
    comments = await getComments(linearId, 30);
  } catch {
    return [];
  }

  // Walk comments chronologically to track which starts have been superseded
  // by a later finish. Linear returns comments oldest-first from getComments.
  // A single "finish" comment supersedes any prior unresolved start because
  // we can't tell sessions apart from the finish comment body — the `done`
  // command posts a generic "finished work" marker with no slot info.
  const sorted = [...comments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const activeClaims: RecentStartClaim[] = [];
  for (const c of sorted) {
    if (FINISH_COMMENT_MARKER.test(c.body)) {
      // Any prior unresolved claim is considered released.
      activeClaims.length = 0;
      continue;
    }
    const claim = parseStartClaim(c);
    if (!claim) continue;
    activeClaims.push(claim);
  }

  const ourSlot = ctx.slot !== null ? `a${ctx.slot}` : null;

  return activeClaims.filter((claim) => {
    // Stale claim → not a collision.
    if (nowMs - new Date(claim.createdAt).getTime() >= DEDUP_WINDOW_MS) {
      return false;
    }
    // Same slot as us → treat as our own prior claim (resume/retry).
    // Both slots null → ambiguous (both running outside a slot dir); don't
    // block, since the main collision case the ticket documents is two
    // different slots.
    if (ourSlot && claim.slot && claim.slot === ourSlot) return false;
    if (!ourSlot && !claim.slot) return false;
    return true;
  });
}

export interface OpenPrMatch {
  number: number;
  title: string;
  url: string;
}

interface GhSearchItem {
  number: number;
  title: string;
  html_url: string;
  body: string | null;
  pull_request?: unknown;
}

interface GhSearchResponse {
  items: GhSearchItem[];
}

/**
 * Find open PRs in the wiki repo whose title or body mentions the Linear ID.
 * Used by `crux linear start` to detect a competing branch before posting a
 * new start claim.
 *
 * Fail-open: returns an empty array if the GitHub search API is unreachable
 * or rate-limited. The comment-based check still runs and provides defense
 * in depth.
 */
export async function findOpenPrsMentioningLinearId(
  linearId: string,
): Promise<OpenPrMatch[]> {
  const q = `${linearId} repo:${REPO} is:pr is:open`;
  const encoded = encodeURIComponent(q);

  let resp: GhSearchResponse;
  try {
    resp = await githubApi<GhSearchResponse>(
      `/search/issues?q=${encoded}&per_page=10`,
    );
  } catch {
    return [];
  }

  // Defensive client-side confirmation: GitHub search is token-based and
  // can occasionally return weak matches. Require the exact ID string to
  // appear in the title or body.
  const escaped = linearId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ref = new RegExp(`\\b${escaped}\\b`, 'i');

  return (resp.items ?? [])
    .filter((item) => item.pull_request !== undefined)
    .filter((item) => ref.test(item.title) || ref.test(item.body ?? ''))
    .map((item) => ({
      number: item.number,
      title: item.title,
      url: item.html_url,
    }));
}
