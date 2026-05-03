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
 * existing values when a key is `undefined`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildChecklistSnapshot } from './session-checklist.ts';
import { checkReviewMarker } from '../review-marker.ts';

export interface SessionSyncPayload {
  /** JSON-stringified ChecklistSnapshot, or undefined if no checklist exists. */
  checksYaml?: string;
  /** True when the review marker is fresh against HEAD; false when missing/stale. */
  reviewed?: boolean;
  /** PR URL discovered via `gh pr view`; undefined when no PR exists for the branch. */
  prUrl?: string;
}

export interface BuildPayloadOptions {
  /** Project root. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Branch to look up a PR for. When omitted, `gh pr view` infers from CWD. */
  branch?: string;
  /**
   * Override the PR URL lookup — e.g. callers that already know the URL
   * (just-pushed-PR flow) can pass it directly to skip the `gh` exec.
   */
  prUrl?: string;
  /**
   * Skip the `gh pr view` shell-out. Tests use this so they don't depend
   * on a live GitHub CLI; production callers usually want it enabled.
   */
  skipPrLookup?: boolean;
}

const CHECKLIST_REL_PATH = '.claude/wip-checklist.md';

/**
 * Look up the PR URL for `branch` via `gh pr view`. Returns undefined if
 * `gh` is missing, the branch has no PR, or the call errors. We never
 * throw — a failed lookup just leaves `prUrl` blank, which preserves
 * whatever the row already had.
 */
function lookupPrUrl(branch: string | undefined, cwd: string): string | undefined {
  try {
    const args = branch
      ? ['pr', 'view', branch, '--json', 'url', '-q', '.url']
      : ['pr', 'view', '--json', 'url', '-q', '.url'];
    const out = execFileSync('gh', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 15_000,
    }).trim();
    if (!out) return undefined;
    if (!out.startsWith('http')) return undefined;
    return out;
  } catch {
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
export function buildSessionSyncPayload(
  options: BuildPayloadOptions = {},
): SessionSyncPayload {
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
  // only when both the SHA and diff hash match HEAD. Anything else (no
  // marker, malformed, stale) is recorded as `reviewed: false` so the
  // dashboard can distinguish "review never ran" from "review ran but
  // data is missing." We DO write `reviewed: false` (not undefined) so a
  // session that genuinely shipped without a review pass shows that fact
  // — see QUA-849 for why the explicit-false matters.
  try {
    const result = checkReviewMarker(cwd);
    payload.reviewed = result.ok;
  } catch {
    // checkReviewMarker only throws on truly unexpected internal errors
    // (it normalizes git failures to `code: 'no-base'`). Be defensive
    // anyway: omit the field rather than guessing.
  }

  // prUrl — explicit override > gh pr view. We never overwrite an
  // existing prUrl with undefined: if the lookup fails, the field is
  // simply omitted from the spread.
  if (options.prUrl) {
    payload.prUrl = options.prUrl;
  } else if (!options.skipPrLookup) {
    const url = lookupPrUrl(options.branch, cwd);
    if (url) payload.prUrl = url;
  }

  return payload;
}
