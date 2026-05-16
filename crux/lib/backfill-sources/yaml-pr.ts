/**
 * End-of-run helper: take the set of YAML files we mutated this run and
 * commit/push/PR them on a fresh branch off origin/main — without ever
 * touching the operator's working tree or current branch.
 *
 * Approach: snapshot the touched YAMLs from the operator's tree, then do
 * all git work inside a temporary `git worktree` checked out at origin/main.
 * The worktree gets removed at the end (success or failure), so the
 * operator's working state is preserved exactly as they had it.
 *
 * Refuses to run when:
 *   - no touched YAMLs exist (nothing to commit)
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

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

  return runYamlPrFlow(input);
}

function runYamlPrFlow(input: OpenYamlPrInput): YamlPrResult {
  // Use an explicit refspec so this works even in shallow / single-branch
  // clones where the default fetch refspec doesn't include `main`.
  try {
    sh('git fetch origin main:refs/remotes/origin/main');
  } catch (err) {
    return { kind: 'error', error: `git fetch origin main failed: ${errMsg(err)}` };
  }

  // Snapshot each touched YAML's content from the operator's working tree.
  // We pass the bytes through to the worktree below so the operator's tree
  // is never modified.
  const snapshot = new Map<string, string>();
  for (const p of input.touchedPaths) {
    try {
      snapshot.set(p, readFileSync(p, 'utf-8'));
    } catch (err) {
      return { kind: 'error', error: `failed to snapshot ${p}: ${errMsg(err)}` };
    }
  }

  const branchName = makeBranchName(input.runStartedAt);
  const worktreePath = join(tmpdir(), `lw-yaml-pr-${process.pid}-${Date.now()}`);

  try {
    sh(`git worktree add -b ${shellEscape(branchName)} ${shellEscape(worktreePath)} origin/main`);
  } catch (err) {
    return { kind: 'error', error: `git worktree add failed: ${errMsg(err)}` };
  }

  try {
    return finishInWorktree(input, snapshot, branchName, worktreePath);
  } finally {
    try {
      sh(`git worktree remove --force ${shellEscape(worktreePath)}`);
    } catch (err) {
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
      process.stderr.write(
        `[yaml-pr] WARNING: failed to clean up worktree ${worktreePath}: ${errMsg(err)}\n`,
      );
    }
  }
}

function finishInWorktree(
  input: OpenYamlPrInput,
  snapshot: Map<string, string>,
  branchName: string,
  worktreePath: string,
): YamlPrResult {
  // Write each touched path's snapshot into the worktree, overwriting
  // origin/main's version. Then stage explicitly.
  for (const [p, content] of snapshot) {
    const dest = join(worktreePath, p);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content, 'utf-8');
    } catch (err) {
      return { kind: 'error', error: `failed to write ${p} in worktree: ${errMsg(err)}` };
    }
  }

  for (const p of input.touchedPaths) {
    try {
      sh(`git -C ${shellEscape(worktreePath)} add -- ${shellEscape(p)}`);
    } catch (err) {
      return { kind: 'error', error: `git add ${p} failed: ${errMsg(err)}` };
    }
  }

  const commitMsg = buildCommitMessage(input);
  try {
    sh(`git -C ${shellEscape(worktreePath)} commit -m ${shellEscape(commitMsg)}`);
  } catch (err) {
    return { kind: 'error', error: `git commit failed: ${errMsg(err)}` };
  }

  try {
    sh(`git -C ${shellEscape(worktreePath)} push -u origin ${shellEscape(branchName)}`);
  } catch (err) {
    return { kind: 'error', error: `git push failed: ${errMsg(err)}` };
  }

  const prBody = buildPrBody(input);
  let prUrl: string;
  try {
    prUrl = sh(
      `cd ${shellEscape(worktreePath)} && ` +
      `gh pr create --head ${shellEscape(branchName)} ` +
      `--title ${shellEscape(`auto: backfill source URLs (${input.summary.matched} matches)`)} ` +
      `--body ${shellEscape(prBody)}`,
    ).trim();
  } catch (err) {
    return { kind: 'error', error: `gh pr create failed: ${errMsg(err)}` };
  }

  // Merging is handled by the `auto-merge-backfill.yml` cron workflow,
  // which polls every 20 minutes and merges any open backfill PR whose CI
  // is green. We don't call `gh pr merge --auto` here because the repo
  // has `allow_auto_merge: false` and the cron is the simpler path.

  return { kind: 'opened', branch: branchName, prUrl };
}

function makeBranchName(isoTs: string): string {
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
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
