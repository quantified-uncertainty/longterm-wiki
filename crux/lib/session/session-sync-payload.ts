/**
 * Session sync payload — gather closing-time fields from local state.
 *
 * QUA-1073: `crux sys agents close` and `crux sys agent-checklist complete`
 * historically PATCHed only `{ status: 'completed' }`, leaving `prUrl`,
 * `checksYaml`, and `reviewed` permanently NULL on `agent_sessions` rows
 * even though the schema, the `PATCH /api/agent-sessions/:id` endpoint,
 * and the `/agent-ship` skill all expect those columns to be populated.
 *
 * Returned fields are all optional: callers spread the result into the
 * PATCH body so missing fields are omitted (the endpoint preserves
 * existing values when a key is `undefined`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildChecklistSnapshot } from './session-checklist.ts';
import { checkReviewMarker } from '../review-marker.ts';
import { getOpenPrUrlByBranch } from '../github.ts';

export interface SessionSyncPayload {
  /** JSON-stringified ChecklistSnapshot, or undefined if no checklist exists. */
  checksYaml?: string;
  /**
   * - `true`  — marker exists, SHA + diff hash both match HEAD.
   * - `false` — marker is missing OR malformed OR stale.
   * - `undefined` — couldn't determine (no merge-base with main, e.g.
   *   fresh worktree). The dashboard distinguishes "ran without
   *   review" (false) from "we have no idea" (undefined).
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
   * → Step 9 close).
   */
  skipPrLookup?: boolean;
}

const CHECKLIST_REL_PATH = '.claude/wip-checklist.md';

/** Best-effort PR URL lookup; never throws. */
async function lookupPrUrl(branch: string | undefined): Promise<string | undefined> {
  if (!branch) return undefined;
  try {
    return (await getOpenPrUrlByBranch(branch)) ?? undefined;
  } catch {
    // A 404 / 401 / network error during close should not block the
    // status update. The next `close` invocation can fill it in.
    return undefined;
  }
}

/**
 * Build the close-time PATCH payload from local state.
 *
 * The checksYaml column is named for historical reasons but stored as
 * JSON — consumers (`/internal/agent-sessions`, `crux sys maintain
 * review-prs`) `JSON.parse(row.checksYaml)`.
 */
export async function buildSessionSyncPayload(
  options: BuildPayloadOptions = {},
): Promise<SessionSyncPayload> {
  const cwd = options.cwd ?? process.cwd();
  const payload: SessionSyncPayload = {};

  try {
    const markdown = readFileSync(join(cwd, CHECKLIST_REL_PATH), 'utf-8');
    payload.checksYaml = JSON.stringify(buildChecklistSnapshot(markdown));
  } catch {
    // Missing or unreadable checklist — best-effort, omit field.
  }

  try {
    const result = checkReviewMarker(cwd);
    if (result.code !== 'no-base') payload.reviewed = result.ok;
  } catch {
    // Defensive: `checkReviewMarker` normalizes git failures to
    // `code: 'no-base'`, so this catch is unreachable in practice.
  }

  if (options.prUrl) {
    payload.prUrl = options.prUrl;
  } else if (!options.skipPrLookup) {
    const url = await lookupPrUrl(options.branch);
    if (url) payload.prUrl = url;
  }

  return payload;
}

/**
 * Both `agent-checklist complete` and `agents close` need the same
 * `{ status: 'completed', ... }` shape — keep the contract in one
 * place so the next close-time field doesn't need to land twice.
 */
export async function buildCloseUpdates(
  options: BuildPayloadOptions = {},
): Promise<{ status: 'completed' } & SessionSyncPayload> {
  const sync = await buildSessionSyncPayload(options);
  return { status: 'completed', ...sync };
}
