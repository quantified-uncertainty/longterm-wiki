/**
 * Dedup helpers for `crux linear start`.
 *
 * Detects whether another session has already claimed a Linear issue, so
 * that two agents don't race to implement the same ticket (QUA-406). Three
 * independent signals, checked in this order:
 *
 * 1. **PG `agent_sessions` (QUA-440)** — the authoritative "who's live
 *    right now" source. Queries sessions with matching `linear_id`,
 *    `status='active'`, and `updated_at > now() - freshMinutes`. Fastest
 *    path (~50ms). Filters out same-slot claims (session resumption).
 * 2. **Linear start comments** — fallback when PG is unreachable or the
 *    session didn't register (early crash). Same filtering rules, parsed
 *    out of `🤖 Claude Code starting work` comment bodies.
 * 3. **Open PRs** in the wiki repo whose title or body mentions the Linear
 *    ID. Paranoia layer — catches abandoned branches that PG has
 *    forgotten about and Linear comments never captured.
 *
 * Any signal is sufficient to block the `start` call. Users can override
 * with `--force` (see `crux linear start --force`). All checks fail-open
 * on API errors: if a source is unreachable, we skip it rather than
 * blocking on a transient glitch. The downside of a rare missed collision
 * is less bad than blocking all sessions when the wiki-server hiccups.
 */

import { githubApi, REPO } from '../github.ts';
import { getComments, type LinearComment } from './issues.ts';
import { getAgentSessionsByLinearId } from '../wiki-server/agent-sessions.ts';
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
 * QUA-440: PG-first lookup for "who's actively claiming this Linear ID?"
 * Queries `agent_sessions` via the wiki-server. Returns claims from other
 * slots only — the caller's own slot is filtered here (session resumption
 * is not a collision).
 *
 * Fail-open: returns null on API error so the caller can fall back to the
 * Linear-comments path. Returning `null` (not `[]`) distinguishes "PG said
 * clean" from "PG was unreachable" — the caller needs to know the
 * difference to decide whether to fall back.
 */
async function findActiveClaimsByOthersFromPg(
  linearId: string,
  ctx: SessionContext,
  freshMinutes: number,
): Promise<RecentStartClaim[] | null> {
  const result = await getAgentSessionsByLinearId(linearId, freshMinutes).catch(
    () => null,
  );
  if (!result || !result.ok) return null;

  const claims: RecentStartClaim[] = [];
  for (const s of result.data.sessions) {
    // Same-slot sessions are our own resumption, not a collision.
    if (ctx.slot !== null && s.slotNumber === ctx.slot) continue;
    // Our own branch — also not a collision. Covers the case where slot was
    // unset at init time (e.g., running outside a slot dir) but the branch
    // matches. Prevents re-init from blocking itself.
    if (s.branch === ctx.branch) continue;
    // `updatedAt` comes back as a string from JSON; normalize defensively
    // in case the serialization ever changes.
    const updatedAt = typeof s.updatedAt === 'string' ? s.updatedAt : String(s.updatedAt);
    // The formatter renders the first non-empty line as the one-line
    // summary. Keep it honest — this claim came from PG, not a Linear
    // comment, and there's no need to fabricate a comment-shaped body.
    claims.push({
      body: `Active session in agent_sessions (last heartbeat ${updatedAt})`,
      createdAt: updatedAt,
      branch: s.branch,
      slot: s.slotNumber !== null ? `a${s.slotNumber}` : null,
    });
  }
  return claims;
}

/**
 * Fetch active claims on this Linear ID from any source. Consults PG
 * first (QUA-440), falls back to Linear start comments (QUA-406) if PG is
 * unreachable or returns no rows.
 *
 * "Active claim" means: posted within the freshness window, from a
 * different slot than ours, and not followed by a "finished work" comment
 * from the same session (Linear-path only — PG uses `status='active'` +
 * heartbeat instead).
 *
 * Same-slot re-runs (init crash recovery, resume) are not blocked — it's
 * the same user reclaiming their own workspace. Cross-slot starts are the
 * collision pattern we care about (QUA-406: a9 vs a16 on the same machine).
 *
 * Fail-open: returns an empty array if BOTH sources are unreachable.
 */
export async function findActiveClaimsByOthers(
  linearId: string,
  ctx: SessionContext,
  nowMs: number = Date.now(),
): Promise<RecentStartClaim[]> {
  // ── Source 1: PG agent_sessions (primary, fastest) ────────────────────
  // The 30-minute freshness window matches the active_agents stale sweep
  // so a session that crashed without running `crux linear done` auto-
  // releases its claim. This window is DELIBERATELY tighter than the
  // 24-hour Linear-comment window (DEDUP_WINDOW_MS): PG has heartbeats
  // and can be precise about liveness, Linear comments cannot.
  const pgClaims = await findActiveClaimsByOthersFromPg(linearId, ctx, 30);
  // When PG is reachable (non-null), trust its result — skip the Linear
  // API round-trip. The paranoia-layer open-PR check still runs regardless.
  // pgClaims === null means PG was unreachable; fall through to Linear then.
  if (pgClaims !== null) return pgClaims;

  // ── Source 2: Linear start comments (fallback when PG unreachable) ────────
  let comments: LinearComment[];
  try {
    comments = await getComments(linearId, 30);
  } catch {
    // PG was unreachable (pgClaims is null) AND Linear is also down — fail-open.
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
