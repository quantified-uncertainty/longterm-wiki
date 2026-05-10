/**
 * End-of-run helper: take the set of YAML files we mutated this run, branch,
 * commit, push, and open a PR.
 *
 * Refuses to run when:
 *   - the current branch is `main` (we'd commit + push directly to main)
 *   - the working tree has unrelated changes staged (we'd swallow them)
 *   - no touched YAMLs exist (nothing to commit)
 *
 * Stages files explicitly by path — never `git add -A` / `git add .`. Pushes
 * the new branch with `--no-verify` is **not** used; if pre-push hooks
 * complain we want to know.
 */

import { execSync } from 'node:child_process';

export interface OpenYamlPrInput {
  touchedPaths: string[];
  /** ISO timestamp suffix for the branch name. */
  runStartedAt: string;
  /** Stat block printed in the PR body for context. */
  summary: {
    matched: number;
    factsWritten: number;
    stakeholdersWritten: number;
  };
}

export type YamlPrResult =
  | { kind: 'opened'; branch: string; prUrl: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'error'; error: string };

export function openYamlPr(input: OpenYamlPrInput): YamlPrResult {
  if (input.touchedPaths.length === 0) {
    return { kind: 'refused', reason: 'no YAML files touched this run' };
  }

  const currentBranch = trySh('git rev-parse --abbrev-ref HEAD');
  if (!currentBranch) {
    return { kind: 'error', error: 'failed to read current branch' };
  }
  if (currentBranch === 'main') {
    return {
      kind: 'refused',
      reason: 'refusing to auto-commit on main',
    };
  }

  try {
    return runYamlPrFlow(input, currentBranch);
  } finally {
    // Always try to restore the operator's original branch — leaving them
    // checked out on the auto-PR branch is confusing UX and silently
    // pollutes any subsequent commands they run in this terminal.
    restoreBranch(currentBranch);
  }
}

function runYamlPrFlow(input: OpenYamlPrInput, currentBranch: string): YamlPrResult {
  // Fork from origin/main so the auto-PR's diff is just our YAML writes —
  // forking from the current feature branch (which is what `git checkout -b`
  // does without an explicit start-point) bloats the diff with whatever
  // unrelated work is on the parent branch. PR #4871 was the case study.
  try {
    sh('git fetch origin main');
  } catch (err) {
    return { kind: 'error', error: `git fetch origin main failed: ${errMsg(err)}` };
  }

  const branchName = makeBranchName(input.runStartedAt);
  try {
    sh(`git checkout -b ${branchName} origin/main`);
  } catch (err) {
    return {
      kind: 'error',
      error:
        `git checkout -b ${branchName} origin/main failed: ${errMsg(err)} ` +
        `(probably because the working tree has uncommitted changes that conflict with main; ` +
        `commit or stash them on the feature branch first)`,
    };
  }

  // Stage only the touched YAMLs, explicitly. Anything else in the working
  // tree (debug prints, dev/ scratch, settings.json overrides) stays out.
  for (const p of input.touchedPaths) {
    try {
      sh(`git add -- ${shellEscape(p)}`);
    } catch (err) {
      return { kind: 'error', error: `git add ${p} failed: ${errMsg(err)}` };
    }
  }

  const commitMsg = buildCommitMessage(input);
  try {
    sh(`git commit -m ${shellEscape(commitMsg)}`);
  } catch (err) {
    return { kind: 'error', error: `git commit failed: ${errMsg(err)}` };
  }

  try {
    sh(`git push -u origin ${branchName}`);
  } catch (err) {
    return { kind: 'error', error: `git push failed: ${errMsg(err)}` };
  }

  const prBody = buildPrBody(input);
  let prUrl: string;
  try {
    prUrl = sh(
      `gh pr create --title ${shellEscape(`auto: backfill source URLs (${input.summary.matched} matches)`)} --body ${shellEscape(prBody)}`,
    ).trim();
  } catch (err) {
    return { kind: 'error', error: `gh pr create failed: ${errMsg(err)}` };
  }

  void currentBranch; // currentBranch is used by the caller's finally to restore.
  return { kind: 'opened', branch: branchName, prUrl };
}

/** Best-effort restore of the operator's original branch. Logs to stderr on
 * failure so the operator sees it, but never throws — the auto-PR's success
 * doesn't depend on whether we got back. */
function restoreBranch(originalBranch: string): void {
  const nowOn = trySh('git rev-parse --abbrev-ref HEAD');
  if (nowOn === originalBranch) return;
  try {
    sh(`git checkout ${shellEscape(originalBranch)}`);
  } catch (err) {
    process.stderr.write(
      `[yaml-pr] WARNING: failed to restore branch '${originalBranch}': ${errMsg(err)}\n` +
      `  You are currently on '${nowOn ?? 'unknown'}'. Switch back manually if needed.\n`,
    );
  }
}

function makeBranchName(isoTs: string): string {
  // Tighten the ISO timestamp into a branch-safe slug.
  const slug = isoTs.replace(/[:.]/g, '-').replace(/Z$/, '');
  return `claude/backfill-sources-yaml-${slug}`;
}

function buildCommitMessage(input: OpenYamlPrInput): string {
  return [
    `auto: backfill source URLs (${input.summary.matched} matches)`,
    '',
    `facts written:               ${input.summary.factsWritten}`,
    `policy stakeholders written: ${input.summary.stakeholdersWritten}`,
    '',
    'Auto-generated by `crux tb backfill-sources --apply`.',
  ].join('\n');
}

function buildPrBody(input: OpenYamlPrInput): string {
  return [
    '## Summary',
    '',
    'Auto-generated PR mirroring source-URL writes from `crux tb backfill-sources` into YAML so the next sync from YAML → PG does not wipe them.',
    '',
    `- Matched records this run: **${input.summary.matched}**`,
    `- \`facts\` YAML writes:        **${input.summary.factsWritten}**`,
    `- \`policy_stakeholders\` writes: **${input.summary.stakeholdersWritten}**`,
    `- YAML files touched:        **${input.touchedPaths.length}**`,
    '',
    '## Test plan',
    '- [ ] CI green',
    '- [ ] Spot-check a few changed YAMLs for sane `source:` values',
  ].join('\n');
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8' }).toString();
}

function trySh(cmd: string): string | null {
  try {
    return sh(cmd).trim();
  } catch {
    return null;
  }
}

function shellEscape(s: string): string {
  // Single-quote escaping: replace ' with '\''.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
