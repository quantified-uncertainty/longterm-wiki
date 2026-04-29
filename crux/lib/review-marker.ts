/**
 * Review-marker check — QUA-849 #7
 *
 * `crux gh pr create` refuses unless `.claude/review-done` exists and is
 * fresh against the current HEAD's commit + diff hash. The marker is
 * written by the `/agent-review-pr` skill at the end of its review pass:
 *
 *   reviewed <commit-sha> <iso-time> <diff-hash>
 *
 * Where `<diff-hash>` is the first 12 chars of `sha256(git diff <merge-base
 * with main>...HEAD)`. The check verifies BOTH the commit SHA and the diff
 * hash so:
 *
 *   - Adding a commit after the review invalidates the marker (SHA mismatch).
 *   - Force-pushing a different commit with the same SHA but different diff
 *     content is also caught (diff hash mismatch — defense-in-depth, this
 *     case is unlikely in practice but cheap to check).
 *   - A missing or zero-byte marker means the review skill never ran.
 *
 * Filed as part of QUA-849 (Inflated review summaries). Companion fixes
 * (artifact-per-phase, force-subagent-execution) catch the "ran skill but
 * lied about phase X" pattern; this check catches the upstream "didn't
 * run the skill at all" pattern, which is the failure mode that produced
 * 2 HIGH bugs on QUA-728 (PR #4689) when the agent went straight from
 * `git push` to `crux gh pr create`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const MARKER_PATH = '.claude/review-done';
const DIFF_HASH_LENGTH = 12;

export interface MarkerCheckResult {
  ok: boolean;
  /** Stable machine-readable code for branching on the failure mode. */
  code: 'ok' | 'missing' | 'malformed' | 'stale-sha' | 'stale-diff' | 'no-base';
  /** Human-readable detail to surface to the operator. */
  message: string;
}

interface ParsedMarker {
  commitSha: string;
  isoTime: string;
  diffHash: string;
}

/**
 * Parse a marker line. Format: `reviewed <sha> <iso> <12-char-hex>`.
 * Returns null if the line doesn't match. Whitespace is tolerated at the
 * start/end and between fields.
 */
export function parseMarker(line: string): ParsedMarker | null {
  // Match the four-token shape; we don't enforce strict ISO format because
  // shells can vary in `date -u` output, and the timestamp is informational
  // (the SHA + diff-hash are what get verified).
  const trimmed = line.trim();
  const match = trimmed.match(
    /^reviewed\s+([0-9a-f]{40})\s+(\S+)\s+([0-9a-f]{12})\s*$/i,
  );
  if (!match) return null;
  return {
    commitSha: match[1].toLowerCase(),
    isoTime: match[2],
    diffHash: match[3].toLowerCase(),
  };
}

/**
 * Compute the diff hash the same way `/agent-review-pr` writes it:
 *   sha256(git diff <merge-base with main>...HEAD).slice(0, 12)
 *
 * Falls back from `origin/main` to `main` so the check works in worktrees
 * that haven't fetched origin yet (rare but the fallback is cheap).
 *
 * Throws on git failure — caller decides whether to surface as `no-base`
 * (likely fresh worktree, no main reference) or rethrow.
 */
export function computeDiffHash(cwd: string = process.cwd()): string {
  // Use execFileSync everywhere instead of execSync so interpolated values
  // (mergeBase) cannot be shell-interpreted. The unified-rule validator
  // `no-exec-sync` rejects template-literal execSync for exactly this
  // reason — defense-in-depth even though `git merge-base` output is
  // always a 40-char hex SHA in practice.
  let mergeBase: string;
  try {
    mergeBase = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
  } catch {
    // Fallback to local `main` ref.
    mergeBase = execFileSync('git', ['merge-base', 'HEAD', 'main'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
  }
  if (!mergeBase) {
    throw new Error('Could not resolve merge-base with main / origin/main');
  }
  // Use Buffer mode (no encoding) so binary diffs hash identically to
  // shasum's behavior. The marker writer pipes the raw `git diff` output
  // to `shasum -a 256`.
  const diffOutput = execFileSync('git', ['diff', `${mergeBase}...HEAD`], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024, // 256MB; large enough for any realistic PR
  });
  return createHash('sha256')
    .update(diffOutput)
    .digest('hex')
    .slice(0, DIFF_HASH_LENGTH);
}

/** Get current HEAD SHA. */
function getHeadSha(cwd: string = process.cwd()): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf-8',
  }).trim().toLowerCase();
}

/**
 * Verify the review marker is present and matches HEAD. Pure of CLI flags
 * — caller decides whether to bypass (e.g. via `--skip-review-check`).
 *
 * Returns `{ ok: true, code: 'ok' }` only when both the SHA and diff hash
 * match. Any mismatch or missing file returns a specific code so the
 * caller can surface differentiated guidance.
 */
export function checkReviewMarker(cwd: string = process.cwd()): MarkerCheckResult {
  const markerPath = `${cwd}/${MARKER_PATH}`;

  if (!existsSync(markerPath)) {
    return {
      ok: false,
      code: 'missing',
      message:
        `No review marker found at ${MARKER_PATH}. ` +
        `Run \`/agent-review-pr\` to do a hostile-reviewer pass on this branch, ` +
        `then re-run this command.`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(markerPath, 'utf-8');
  } catch (e: unknown) {
    return {
      ok: false,
      code: 'malformed',
      message:
        `Could not read ${MARKER_PATH}: ${e instanceof Error ? e.message : String(e)}. ` +
        `Re-run \`/agent-review-pr\` to regenerate.`,
    };
  }
  const parsed = parseMarker(raw);
  if (!parsed) {
    return {
      ok: false,
      code: 'malformed',
      message:
        `Review marker at ${MARKER_PATH} is malformed (expected ` +
        `\`reviewed <40-char-sha> <iso-time> <12-char-hex>\`). ` +
        `Got: ${JSON.stringify(raw.slice(0, 200))}. ` +
        `Re-run \`/agent-review-pr\` to regenerate.`,
    };
  }

  let headSha: string;
  try {
    headSha = getHeadSha(cwd);
  } catch (e: unknown) {
    return {
      ok: false,
      code: 'no-base',
      message:
        `Could not resolve HEAD: ${e instanceof Error ? e.message : String(e)}. ` +
        `If you're not in a git repository, this command doesn't apply. ` +
        `Otherwise, check that the working tree is intact.`,
    };
  }
  if (parsed.commitSha !== headSha) {
    return {
      ok: false,
      code: 'stale-sha',
      message:
        `Review marker is stale: marker covers commit ${parsed.commitSha.slice(0, 12)} ` +
        `but HEAD is ${headSha.slice(0, 12)}. ` +
        `New commits landed since the review pass — re-run \`/agent-review-pr\` ` +
        `to verify the new diff.`,
    };
  }

  let currentDiffHash: string;
  try {
    currentDiffHash = computeDiffHash(cwd);
  } catch (e: unknown) {
    return {
      ok: false,
      code: 'no-base',
      message:
        `Could not compute diff hash to verify review marker: ` +
        `${e instanceof Error ? e.message : String(e)}. ` +
        `This usually means the branch has no merge-base with main / origin/main. ` +
        `If this is intentional (e.g. a totally new history), pass ` +
        `\`--skip-review-check --reason=...\` to bypass.`,
    };
  }

  if (parsed.diffHash !== currentDiffHash) {
    return {
      ok: false,
      code: 'stale-diff',
      message:
        `Review marker SHA matches HEAD but diff hash differs ` +
        `(marker: ${parsed.diffHash}, current: ${currentDiffHash}). ` +
        `The branch was force-pushed or rebased after the review. ` +
        `Re-run \`/agent-review-pr\` to verify the new diff content.`,
    };
  }

  return {
    ok: true,
    code: 'ok',
    message: `Review marker fresh (commit ${parsed.commitSha.slice(0, 12)}, ${parsed.isoTime}).`,
  };
}
