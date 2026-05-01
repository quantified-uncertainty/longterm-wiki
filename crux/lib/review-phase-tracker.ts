/**
 * Review Phase Tracker — structural enforcement for /agent-review-pr phases.
 *
 * Pure logic helpers. The CLI commands and the agent-review-pr skill consume
 * these to record phase execution and gate the marker file write. See QUA-950
 * and `.claude/commands/agent-review-pr.md`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from './content-types.ts';
import { computeDiffHash as computeMarkerDiffHash } from './review-marker.ts';

export const TRACKER_PATH = join(PROJECT_ROOT, '.claude/review-phases-done');

/**
 * Canonical phase IDs that map 1:1 to /agent-review-pr phases.
 *
 * QUA-961 (merged 2026-04-30) consolidated the prior 10-phase list down to
 * 7 by folding the simplification + coverage-audit passes into Phase 3b's
 * hostile-reviewer prompt — they reliably found nothing on their own
 * because 3b already covered them. This list tracks the post-QUA-961
 * structure; do NOT split simplify/coverage back out as standalone
 * phases (per QUA-961's directive in the skill text).
 *
 * `phase-1-triage`, `phase-2-mechanical`, and `phase-6-final` are not
 * skippable — they always execute. The remaining phases are skippable
 * with `reason=...`. The marker write requires every phase to have
 * either a recorded timestamp or a skip reason.
 */
export const PHASE_IDS = [
  'phase-1-triage',
  'phase-2-mechanical',
  'phase-3a-narrow',
  'phase-3b-hostile',
  'phase-4-redteam',
  'phase-5-category',
  'phase-6-final',
] as const;

export type PhaseId = (typeof PHASE_IDS)[number];

/**
 * Phases that cannot be skipped — `reason=...` is rejected.
 *
 * These run on every review regardless of PR shape (a content-only PR still
 * runs triage and mechanical checks). Skipping them is the exact failure mode
 * QUA-950 was filed for.
 */
export const NON_SKIPPABLE_PHASES = new Set<PhaseId>([
  'phase-1-triage',
  'phase-2-mechanical',
  'phase-6-final',
]);

export interface PhaseEntry {
  phaseId: PhaseId;
  timestamp: string;
  reason?: string;
}

export interface InitMetadata {
  commitSha: string;
  diffHash: string;
  timestamp: string;
}

export interface TrackerState {
  init: InitMetadata | null;
  entries: PhaseEntry[];
}

/**
 * Re-export the marker's canonical diff-hash so the tracker and the marker
 * stay in lockstep — drift between the two would defeat the inSync check.
 *
 * The hostile-reviewer pass on QUA-950 caught a duplicate implementation
 * here that used template-literal `execSync` (gate-failing under the
 * `no-exec-sync` rule) and spawned `shasum` instead of `node:crypto`.
 * Reuse is the simpler answer.
 */
export const computeDiffHash = computeMarkerDiffHash;

export function getHeadSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf-8',
  }).trim();
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Parse the tracker file. Format:
 *
 *   init <sha> <diff_hash> <timestamp>
 *   <phase-id> <timestamp>
 *   <phase-id> <timestamp> reason=<text...>
 *
 * Lines beginning with `#` and blank lines are ignored. Unknown phase IDs
 * are dropped (forward-compatibility — newer trackers in older clients).
 */
export function parseTracker(content: string): TrackerState {
  const state: TrackerState = { init: null, entries: [] };
  const validIds = new Set<string>(PHASE_IDS);

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('init ')) {
      const parts = line.split(/\s+/);
      // init <sha> <diff_hash> <timestamp>
      if (parts.length >= 4) {
        state.init = {
          commitSha: parts[1],
          diffHash: parts[2],
          timestamp: parts[3],
        };
      }
      continue;
    }

    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const phaseId = line.slice(0, spaceIdx);
    if (!validIds.has(phaseId)) continue;

    const rest = line.slice(spaceIdx + 1).trim();
    const reasonIdx = rest.indexOf('reason=');
    let timestamp: string;
    let reason: string | undefined;
    if (reasonIdx === -1) {
      timestamp = rest;
    } else {
      timestamp = rest.slice(0, reasonIdx).trim();
      reason = rest.slice(reasonIdx + 'reason='.length).trim();
    }

    if (!timestamp) continue;
    state.entries.push({ phaseId: phaseId as PhaseId, timestamp, reason });
  }

  return state;
}

export function readTracker(path: string = TRACKER_PATH): TrackerState {
  if (!existsSync(path)) {
    return { init: null, entries: [] };
  }
  return parseTracker(readFileSync(path, 'utf-8'));
}

/**
 * Initialize the tracker. Truncates any existing file — a fresh review starts
 * with a fresh tracker. The init line records the commit + diff hash so callers
 * can detect that the tracker is anchored to the right state.
 *
 * `path` is injectable so tests can use a temp file without disturbing the
 * real `.claude/` directory.
 */
export function initTracker(meta?: Partial<InitMetadata>, path: string = TRACKER_PATH): InitMetadata {
  const init: InitMetadata = {
    commitSha: meta?.commitSha ?? getHeadSha(),
    diffHash: meta?.diffHash ?? computeDiffHash(),
    timestamp: meta?.timestamp ?? nowIso(),
  };
  const line = `init ${init.commitSha} ${init.diffHash} ${init.timestamp}\n`;
  writeFileSync(path, line, 'utf-8');
  return init;
}

export interface RecordOptions {
  reason?: string;
  /** Override the timestamp — for tests. */
  timestamp?: string;
}

export interface RecordResult {
  ok: boolean;
  error?: string;
  entry?: PhaseEntry;
}

/**
 * Record execution (or skip-with-reason) of a phase. Idempotent: re-recording
 * the same phase appends a new line — `validate` reads the most recent entry.
 * Idempotency is intentional: if a phase runs twice (e.g. fixed a HIGH then
 * re-ran), both timestamps are preserved for audit.
 */
export function recordPhase(
  phaseId: string,
  options: RecordOptions = {},
  path: string = TRACKER_PATH,
): RecordResult {
  if (!PHASE_IDS.includes(phaseId as PhaseId)) {
    return {
      ok: false,
      error: `Unknown phase: ${phaseId}. Valid IDs: ${PHASE_IDS.join(', ')}`,
    };
  }

  const reason = options.reason?.trim();
  if (reason && NON_SKIPPABLE_PHASES.has(phaseId as PhaseId)) {
    return {
      ok: false,
      error: `Phase ${phaseId} cannot be skipped — it must execute on every review.`,
    };
  }

  // Reasons round-trip through a one-line file format. A `\n` in the
  // reason would let the agent forge additional phase entries via a
  // single --reason argument. Reject up front rather than escape:
  // valid skip reasons are short prose, never multiline.
  if (reason && /[\n\r]/.test(reason)) {
    return {
      ok: false,
      error: `--reason must not contain newlines. Use a single-line justification.`,
    };
  }
  // Sanity cap. Real skip reasons are sentence-length, not novel-length.
  // A 100KB reason would still parse but signals operator confusion.
  if (reason && reason.length > 500) {
    return {
      ok: false,
      error: `--reason is too long (${reason.length} chars, max 500).`,
    };
  }

  if (!existsSync(path)) {
    return {
      ok: false,
      error: `Tracker not initialized — run \`crux sys review-phase init\` first.`,
    };
  }

  const timestamp = options.timestamp ?? nowIso();
  const entry: PhaseEntry = { phaseId: phaseId as PhaseId, timestamp, reason };
  const line = reason
    ? `${phaseId} ${timestamp} reason=${reason}\n`
    : `${phaseId} ${timestamp}\n`;
  appendFileSync(path, line, 'utf-8');
  return { ok: true, entry };
}

export interface ValidateResult {
  ok: boolean;
  missing: PhaseId[];
  init: InitMetadata | null;
  /** True if the tracker's init metadata matches the current branch state. */
  inSync: boolean;
  /** Per-phase: most-recent entry or null if missing. */
  entries: Record<PhaseId, PhaseEntry | null>;
}

/**
 * Validate that every required phase has at least one entry. Each entry must
 * be either a timestamp (executed) or a skip-with-reason (with `reason=...`).
 *
 * `inSync` checks whether the recorded init metadata still matches the current
 * branch — a tracker initialized against an older HEAD is stale. The marker
 * write should refuse if the tracker is out-of-sync.
 */
export function validateTracker(state?: TrackerState, path: string = TRACKER_PATH): ValidateResult {
  const tracker = state ?? readTracker(path);
  const entries = {} as Record<PhaseId, PhaseEntry | null>;
  for (const id of PHASE_IDS) entries[id] = null;

  // Most-recent-wins: each phase's last line is the source of truth.
  for (const entry of tracker.entries) {
    entries[entry.phaseId] = entry;
  }

  const missing = PHASE_IDS.filter((id) => entries[id] === null);

  let inSync = false;
  if (tracker.init) {
    try {
      const headSha = getHeadSha();
      const diffHash = computeDiffHash();
      inSync = tracker.init.commitSha === headSha && tracker.init.diffHash === diffHash;
    } catch {
      // git unreachable in tests / outside a repo; treat as in-sync.
      inSync = true;
    }
  }

  return {
    ok: missing.length === 0 && tracker.init !== null,
    missing,
    init: tracker.init,
    inSync,
    entries,
  };
}

/**
 * Format a one-line summary of skipped phases for the PR body. Returns null
 * when no phases were skipped (no need to add a section).
 */
export function summarizeSkipped(state?: TrackerState, path: string = TRACKER_PATH): string | null {
  const tracker = state ?? readTracker(path);
  const validation = validateTracker(tracker, path);
  const skipped: { phase: PhaseId; reason: string }[] = [];
  for (const id of PHASE_IDS) {
    const entry = validation.entries[id];
    if (entry?.reason) skipped.push({ phase: id, reason: entry.reason });
  }
  if (skipped.length === 0) return null;
  return skipped.map(({ phase, reason }) => `- ${phase}: ${reason}`).join('\n');
}
