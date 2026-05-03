/**
 * Session sync payload — gather closing-time fields from local state.
 *
 * QUA-1073: `crux sys agents close` and `crux sys agent-checklist complete`
 * historically PATCHed only `{ status: 'completed' }`, leaving `prUrl`,
 * `checksYaml`, and `reviewed` permanently NULL on `agent_sessions` rows
 * even though the schema, the `PATCH /api/agent-sessions/:id` endpoint,
 * and the `/agent-ship` skill all expect those columns to be populated.
 *
 * This helper collects the three values from the artifacts that already
 * exist locally at session close — the WIP checklist, the review marker,
 * and the GitHub PR for the current branch — so the existing close paths
 * can stop relying on the agent to remember to send them by hand.
 *
 * Returned fields are all optional: callers spread the result into the
 * PATCH body so missing fields are omitted (the endpoint preserves
 * existing values when a key is `undefined`). In particular, the PR
 * lookup is best-effort: at `complete`-time (Step 7 of `/agent-ship`)
 * the PR doesn't exist yet so `prUrl` will be omitted; `close` (Step 9,
 * after push) finds the now-existing PR and overwrites with its URL.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildChecklistSnapshot } from './session-checklist.ts';
import { checkReviewMarker } from '../review-marker.ts';
import { getOpenPrUrlByBranch } from '../github.ts';

export interface SessionSyncPayload {
  /** JSON-stringified ChecklistSnapshot, or undefined if no checklist exists. */
  checksYaml?: string;
  /**
   * True/false from the review marker.
   *
   * - `true`  — marker exists, SHA + diff hash both match HEAD.
   * - `false` — marker is missing OR malformed OR stale (SHA / diff hash drift).
   * - `undefined` — couldn't determine (no merge-base with main, e.g. fresh
   *   worktree). We omit rather than guess so the dashboard can distinguish
   *   "ran without review" from "we have no idea."
   */
  reviewed?: boolean;
  /** PR URL discovered via the GitHub API; undefined when no PR exists. */
  prUrl?: string;
}

export interface BuildPayloadOptions {
  /** Project root. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Branch to look up a PR for. Required for the prUrl lookup. */
  branch?: string;
  /**
   * Override the PR URL lookup — e.g. callers that already know the URL
   * (just-pushed-PR flow) can pass it directly to skip the API call.
   */
  prUrl?: string;
  /**
   * Skip the PR lookup. Used by `agent-checklist complete`, which runs
   * BEFORE the PR exists in the `/agent-ship` flow (Step 7 → Step 8 push
   * → Step 9 close). Also useful in tests so the suite doesn't depend on
   * GITHUB_TOKEN.
   */
  skipPrLookup?: boolean;
}

const CHECKLIST_REL_PATH = '.claude/wip-checklist.md';

/**
 * Look up the PR URL for `branch`. Returns undefined on any failure (no
 * branch, no PR for the branch, network error, missing token). Never
 * throws — a failed lookup just leaves `prUrl` blank, which preserves
 * whatever the row already had.
 */
async function lookupPrUrl(branch: string | undefined): Promise<string | undefined> {
  if (!branch) return undefined;
  try {
    const url = await getOpenPrUrlByBranch(branch);
    return url ?? undefined;
  } catch {
    // Best-effort: a 404 / 401 / network error during close should not
    // block the status update. The next `close` invocation (or a manual
    // PATCH) can fill it in.
    return undefined;
  }
}

/**
 * Build the close-time PATCH payload from local state. All fields are
 * best-effort: if the artifact is missing or the lookup fails, the field
 * is omitted from the result rather than set to null. That preserves any
 * existing value the caller may have already written.
 *
 * The checklist snapshot is serialized as compact JSON (the column is
 * named `checksYaml` for historical reasons but the consumers — the
 * `/internal/agent-sessions` dashboard and `crux sys maintain
 * review-prs` — parse it as JSON via `JSON.parse(row.checksYaml)`).
 */
export async function buildSessionSyncPayload(
  options: BuildPayloadOptions = {},
): Promise<SessionSyncPayload> {
  const cwd = options.cwd ?? process.cwd();
  const payload: SessionSyncPayload = {};

  // checksYaml — from .claude/wip-checklist.md
  const checklistPath = join(cwd, CHECKLIST_REL_PATH);
  if (existsSync(checklistPath)) {
    try {
      const markdown = readFileSync(checklistPath, 'utf-8');
      const snapshot = buildChecklistSnapshot(markdown);
      payload.checksYaml = JSON.stringify(snapshot);
    } catch {
      // Best-effort: a corrupted checklist shouldn't block session close.
    }
  }

  // reviewed — from .claude/review-done. The marker check returns ok=true
  // only when both the SHA and diff hash match HEAD. We treat the discrete
  // failure modes as `false` (review didn't ship), but `no-base` (couldn't
  // compute the diff hash, e.g. fresh worktree) is undetermined — omit
  // rather than guess `false`, so the dashboard can distinguish.
  try {
    const result = checkReviewMarker(cwd);
    if (result.code !== 'no-base') payload.reviewed = result.ok;
  } catch {
    // checkReviewMarker normalizes git failures to `code: 'no-base'`; this
    // catch is purely defensive against an unexpected internal throw.
  }

  // prUrl — explicit override > API lookup > omitted. We never overwrite
  // an existing prUrl with undefined: if the lookup fails, the field is
  // simply omitted from the spread.
  if (options.prUrl) {
    payload.prUrl = options.prUrl;
  } else if (!options.skipPrLookup) {
    const url = await lookupPrUrl(options.branch);
    if (url) payload.prUrl = url;
  }

  return payload;
}

/**
 * Close-time PATCH consolidator. Both `agent-checklist complete` and
 * `agents close` need the same shape — `{ status: 'completed', ... }` —
 * so the QUA-1073 contract lives in one place. A future "must-send-at-
 * close" addition (e.g. `learningsJson` derived from the transcript)
 * lands here, not in two callsites.
 */
export async function buildCloseUpdates(
  options: BuildPayloadOptions = {},
): Promise<{ status: 'completed' } & SessionSyncPayload> {
  const sync = await buildSessionSyncPayload(options);
  return { status: 'completed', ...sync };
}
