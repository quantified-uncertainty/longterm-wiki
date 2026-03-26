/**
 * Branch Management Command Handlers
 *
 * Audit, clean up, and recover stale remote branches.
 *
 * Usage:
 *   crux gh branches audit              Categorize all remote branches, show post-merge diffs
 *   crux gh branches cleanup [--dry-run] Delete branches that are safe to remove
 *   crux gh branches recover <branch>    Cherry-pick post-merge commits as a new PR
 *   crux gh branches status              Quick summary of branch counts by category
 */

import { createLogger } from '../lib/output.ts';
import { git, gitSafe } from '../lib/git.ts';
import { githubApi, githubApiPaginated, REPO } from '../lib/github.ts';
import type { CommandOptions, CommandResult } from '../lib/command-types.ts';

const log = createLogger();

// ── Types ────────────────────────────────────────────────────────────────────

interface BranchInfo {
  name: string; // e.g. "claude/fix-something" (no origin/ prefix)
  lastCommitDate: string;
  prNumber: number | null;
  prState: 'MERGED' | 'OPEN' | 'CLOSED' | null;
  prMergedAt: string | null;
  /** Number of commits on this branch that are not on main */
  commitsAheadOfMain: number;
}

type BranchCategory =
  | 'merged-into-main' // git says fully merged
  | 'pr-merged-extra-commits' // PR merged (squash), but branch has extra commits
  | 'pr-closed' // PR was closed without merge
  | 'pr-open' // PR is still open
  | 'no-pr' // No associated PR
  | 'protected'; // production, main, etc.

interface CategorizedBranch extends BranchInfo {
  category: BranchCategory;
}

/** Raw GitHub REST API PR response (snake_case fields) */
interface GHPrRaw {
  number: number;
  state: string;
  merged_at: string | null;
  head: { ref: string };
}

interface GHPrInfo {
  number: number;
  state: string;
  mergedAt: string | null;
  headRefName: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const PROTECTED_BRANCHES = new Set(['main', 'production']);

function getRemoteBranches(): string[] {
  const output = git('branch', '-r');
  return output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('origin/') && !l.includes('->'))
    .map((l) => l.replace('origin/', ''));
}

function getMergedBranches(): Set<string> {
  const output = git('branch', '-r', '--merged', 'main');
  return new Set(
    output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('origin/') && !l.includes('->'))
      .map((l) => l.replace('origin/', '')),
  );
}

function getLastCommitDate(branch: string): string {
  const result = gitSafe('log', '-1', '--format=%ci', `origin/${branch}`);
  return result.ok ? result.output.split(' ')[0] : 'unknown';
}

function getCommitsAhead(branch: string): number {
  const result = gitSafe('log', '--oneline', `origin/main..origin/${branch}`);
  if (!result.ok) return 0;
  return result.output ? result.output.split('\n').length : 0;
}

function getCommitSummaries(branch: string, limit = 10): string[] {
  const result = gitSafe(
    'log',
    '--oneline',
    `--max-count=${limit}`,
    `origin/main..origin/${branch}`,
  );
  if (!result.ok || !result.output) return [];
  return result.output.split('\n');
}

/**
 * Fetch PR info for all branches in bulk using GitHub API pagination.
 * Much faster than per-branch gh CLI calls.
 */
async function fetchAllPrInfo(): Promise<Map<string, GHPrInfo>> {
  const map = new Map<string, GHPrInfo>();

  // Fetch merged + closed + open PRs (paginated, up to 1000 each)
  // GitHub REST API returns snake_case fields, so we normalize to camelCase
  for (const state of ['closed', 'open'] as const) {
    const rawPrs = await githubApiPaginated<GHPrRaw>(
      `/repos/${REPO}/pulls?state=${state}&per_page=100&sort=updated&direction=desc`,
      10,
    );
    for (const raw of rawPrs) {
      const branchName = raw.head.ref;
      // Only keep the most recent PR per branch
      if (!map.has(branchName)) {
        map.set(branchName, {
          number: raw.number,
          state: raw.state,
          mergedAt: raw.merged_at,
          headRefName: branchName,
        });
      }
    }
  }

  return map;
}

async function categorizeBranches(
  branches: string[],
  prInfo: Map<string, GHPrInfo>,
  mergedSet: Set<string>,
): Promise<CategorizedBranch[]> {
  const result: CategorizedBranch[] = [];

  for (const name of branches) {
    if (name === 'main' || PROTECTED_BRANCHES.has(name)) {
      result.push({
        name,
        lastCommitDate: getLastCommitDate(name),
        prNumber: null,
        prState: null,
        prMergedAt: null,
        commitsAheadOfMain: 0,
        category: 'protected',
      });
      continue;
    }

    const pr = prInfo.get(name);
    const isMergedIntoMain = mergedSet.has(name);
    const commitsAhead = isMergedIntoMain ? 0 : getCommitsAhead(name);

    let prState: BranchInfo['prState'] = null;
    let prMergedAt: string | null = null;
    if (pr) {
      prMergedAt = pr.mergedAt;
      if (pr.mergedAt) {
        prState = 'MERGED';
      } else if (pr.state === 'open') {
        prState = 'OPEN';
      } else {
        prState = 'CLOSED';
      }
    }

    let category: BranchCategory;
    if (isMergedIntoMain) {
      category = 'merged-into-main';
    } else if (prState === 'OPEN') {
      category = 'pr-open';
    } else if (prState === 'MERGED') {
      category = 'pr-merged-extra-commits';
    } else if (prState === 'CLOSED') {
      category = 'pr-closed';
    } else {
      category = 'no-pr';
    }

    result.push({
      name,
      lastCommitDate: getLastCommitDate(name),
      prNumber: pr?.number ?? null,
      prState,
      prMergedAt,
      commitsAheadOfMain: commitsAhead,
      category,
    });
  }

  return result;
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function statusCommand(): Promise<CommandResult> {
  log.heading('Branch Status');

  // Fetch remote info
  git('fetch', '--prune', 'origin');
  const branches = getRemoteBranches();
  const mergedSet = getMergedBranches();
  const prInfo = await fetchAllPrInfo();
  const categorized = await categorizeBranches(branches, prInfo, mergedSet);

  const counts: Record<BranchCategory, number> = {
    'merged-into-main': 0,
    'pr-merged-extra-commits': 0,
    'pr-closed': 0,
    'pr-open': 0,
    'no-pr': 0,
    protected: 0,
  };

  for (const b of categorized) {
    counts[b.category]++;
  }

  const { green, yellow, red, cyan, dim, reset, bold } = log.colors;
  const lines: string[] = [];

  lines.push(`Total remote branches: ${bold}${branches.length}${reset}`);
  lines.push('');
  lines.push(
    `  ${green}${log.successIcon}${reset} Merged into main (safe to delete):  ${bold}${counts['merged-into-main']}${reset}`,
  );
  lines.push(
    `  ${yellow}${log.warnIcon}${reset} PR merged, extra commits remain:   ${bold}${counts['pr-merged-extra-commits']}${reset}`,
  );
  lines.push(
    `  ${red}${log.errorIcon}${reset} PR closed (abandoned):             ${bold}${counts['pr-closed']}${reset}`,
  );
  lines.push(
    `  ${cyan}${log.infoIcon}${reset} PR open (active):                  ${bold}${counts['pr-open']}${reset}`,
  );
  lines.push(
    `  ${dim}○${reset} No PR:                             ${bold}${counts['no-pr']}${reset}`,
  );
  lines.push(
    `  ${dim}◆${reset} Protected:                         ${bold}${counts['protected']}${reset}`,
  );

  const deletable =
    counts['merged-into-main'] + counts['pr-merged-extra-commits'] + counts['pr-closed'];
  lines.push('');
  lines.push(
    `${bold}Deletable:${reset} ${deletable} branches (run ${cyan}crux gh branches cleanup --dry-run${reset} for details)`,
  );

  return { output: lines.join('\n'), exitCode: 0 };
}

async function auditCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  log.heading('Branch Audit');

  git('fetch', '--prune', 'origin');
  const branches = getRemoteBranches();
  const mergedSet = getMergedBranches();
  const prInfo = await fetchAllPrInfo();
  const categorized = await categorizeBranches(branches, prInfo, mergedSet);

  const { green, yellow, red, cyan, dim, bold, reset } = log.colors;
  const lines: string[] = [];

  // Group by category
  const groups: Record<BranchCategory, CategorizedBranch[]> = {
    'merged-into-main': [],
    'pr-merged-extra-commits': [],
    'pr-closed': [],
    'pr-open': [],
    'no-pr': [],
    protected: [],
  };

  for (const b of categorized) {
    groups[b.category].push(b);
  }

  // 1. Post-merge extra commits (most interesting)
  if (groups['pr-merged-extra-commits'].length > 0) {
    const sorted = groups['pr-merged-extra-commits'].sort(
      (a, b) => b.commitsAheadOfMain - a.commitsAheadOfMain,
    );
    lines.push(
      `\n${yellow}${bold}═══ PR Merged + Extra Commits (${sorted.length} branches) ═══${reset}`,
    );
    lines.push(
      `${dim}These branches had commits pushed after the PR was squash-merged.${reset}`,
    );
    lines.push(
      `${dim}The extra commits were never included in main.${reset}\n`,
    );

    for (const b of sorted) {
      lines.push(
        `  ${yellow}▸${reset} ${bold}${b.name}${reset}  ${dim}PR #${b.prNumber}${reset}  ${yellow}${b.commitsAheadOfMain} extra commit(s)${reset}  ${dim}last: ${b.lastCommitDate}${reset}`,
      );
      const summaries = getCommitSummaries(b.name, 5);
      for (const s of summaries) {
        lines.push(`    ${dim}${s}${reset}`);
      }
    }
    lines.push(
      `\n${dim}To recover: crux gh branches recover <branch-name>${reset}`,
    );
  }

  // 2. Closed PRs
  if (groups['pr-closed'].length > 0) {
    const sorted = groups['pr-closed'].sort((a, b) =>
      b.lastCommitDate.localeCompare(a.lastCommitDate),
    );
    lines.push(
      `\n${red}${bold}═══ PR Closed / Abandoned (${sorted.length} branches) ═══${reset}`,
    );
    lines.push(
      `${dim}PR was closed without merge. Branch content was not included in main.${reset}\n`,
    );

    for (const b of sorted) {
      lines.push(
        `  ${red}✗${reset} ${b.name}  ${dim}PR #${b.prNumber}  ${b.commitsAheadOfMain} commit(s)  last: ${b.lastCommitDate}${reset}`,
      );
    }
  }

  // 3. No PR
  if (groups['no-pr'].length > 0) {
    lines.push(
      `\n${dim}${bold}═══ No PR (${groups['no-pr'].length} branches) ═══${reset}`,
    );
    for (const b of groups['no-pr']) {
      lines.push(
        `  ${dim}○${reset} ${b.name}  ${dim}${b.commitsAheadOfMain} commit(s)  last: ${b.lastCommitDate}${reset}`,
      );
    }
  }

  // 4. Open PRs
  if (groups['pr-open'].length > 0) {
    lines.push(
      `\n${cyan}${bold}═══ PR Open (${groups['pr-open'].length} branches) ═══${reset}`,
    );
    lines.push(`${dim}Active work — will NOT be deleted.${reset}\n`);
    for (const b of groups['pr-open']) {
      lines.push(
        `  ${cyan}●${reset} ${b.name}  ${dim}PR #${b.prNumber}  ${b.commitsAheadOfMain} commit(s)  last: ${b.lastCommitDate}${reset}`,
      );
    }
  }

  // 5. Summary
  lines.push(
    `\n${bold}═══ Summary ═══${reset}`,
  );
  lines.push(`  Merged into main (safe to delete): ${green}${groups['merged-into-main'].length}${reset}`);
  lines.push(`  PR merged + extra commits:         ${yellow}${groups['pr-merged-extra-commits'].length}${reset}`);
  lines.push(`  PR closed (abandoned):             ${red}${groups['pr-closed'].length}${reset}`);
  lines.push(`  PR open (active):                  ${cyan}${groups['pr-open'].length}${reset}`);
  lines.push(`  No PR:                             ${dim}${groups['no-pr'].length}${reset}`);
  lines.push(`  Protected:                         ${dim}${groups['protected'].length}${reset}`);

  return { output: lines.join('\n'), exitCode: 0 };
}

async function cleanupCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const dryRun = Boolean(options.dryRun ?? options['dry-run']);
  const { green, yellow, red, cyan, dim, bold, reset } = log.colors;

  log.heading(dryRun ? 'Branch Cleanup (dry run)' : 'Branch Cleanup');

  git('fetch', '--prune', 'origin');
  const branches = getRemoteBranches();
  const mergedSet = getMergedBranches();
  const prInfo = await fetchAllPrInfo();
  const categorized = await categorizeBranches(branches, prInfo, mergedSet);

  // Deletable categories: merged-into-main, pr-merged-extra-commits, pr-closed
  const toDelete = categorized.filter(
    (b) =>
      b.category === 'merged-into-main' ||
      b.category === 'pr-merged-extra-commits' ||
      b.category === 'pr-closed',
  );

  if (toDelete.length === 0) {
    return { output: 'No branches to clean up.', exitCode: 0 };
  }

  const lines: string[] = [];
  const byCategory: Record<string, CategorizedBranch[]> = {};
  for (const b of toDelete) {
    (byCategory[b.category] ??= []).push(b);
  }

  if (byCategory['merged-into-main']?.length) {
    lines.push(
      `${green}Merged into main:${reset} ${byCategory['merged-into-main'].length} branches`,
    );
  }
  if (byCategory['pr-merged-extra-commits']?.length) {
    lines.push(
      `${yellow}PR merged + extra commits:${reset} ${byCategory['pr-merged-extra-commits'].length} branches`,
    );
    for (const b of byCategory['pr-merged-extra-commits']) {
      lines.push(
        `  ${yellow}▸${reset} ${b.name} (${b.commitsAheadOfMain} extra commits, PR #${b.prNumber})`,
      );
    }
  }
  if (byCategory['pr-closed']?.length) {
    lines.push(
      `${red}PR closed (abandoned):${reset} ${byCategory['pr-closed'].length} branches`,
    );
  }

  lines.push(`\n${bold}Total: ${toDelete.length} branches to delete${reset}`);

  if (dryRun) {
    lines.push(`\n${dim}Dry run — no branches deleted. Remove --dry-run to execute.${reset}`);
    return { output: lines.join('\n'), exitCode: 0 };
  }

  // Actually delete
  let deleted = 0;
  let failed = 0;
  const errors: string[] = [];

  // Batch delete using git push --delete (up to 50 at a time to avoid arg limits)
  const batchSize = 50;
  for (let i = 0; i < toDelete.length; i += batchSize) {
    const batch = toDelete.slice(i, i + batchSize);
    const refs = batch.map((b) => `:refs/heads/${b.name}`);
    const result = gitSafe('push', 'origin', ...refs);
    if (result.ok) {
      deleted += batch.length;
    } else {
      // Fall back to individual deletes for this batch
      for (const b of batch) {
        const individual = gitSafe('push', 'origin', '--delete', b.name);
        if (individual.ok) {
          deleted++;
        } else {
          failed++;
          errors.push(`  ${b.name}: ${individual.stderr}`);
        }
      }
    }

    // Progress update
    if (toDelete.length > batchSize) {
      const progress = Math.min(i + batchSize, toDelete.length);
      log.dim(`  Deleted ${progress}/${toDelete.length}...`);
    }
  }

  lines.push(`\n${green}${log.successIcon} Deleted: ${deleted}${reset}`);
  if (failed > 0) {
    lines.push(`${red}${log.errorIcon} Failed: ${failed}${reset}`);
    lines.push(errors.join('\n'));
  }

  return { output: lines.join('\n'), exitCode: failed > 0 ? 1 : 0 };
}

async function recoverCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const branchName = args[0];
  if (!branchName) {
    return {
      output: 'Usage: crux gh branches recover <branch-name>\n\n' +
        'Cherry-picks post-merge commits from a stale branch into a new PR.\n' +
        'Run `crux gh branches audit` first to see which branches have recoverable commits.',
      exitCode: 1,
    };
  }

  const { green, yellow, dim, bold, reset } = log.colors;

  // Strip origin/ prefix if provided
  const clean = branchName.replace(/^origin\//, '');

  log.heading(`Recovering: ${clean}`);

  // Verify branch exists
  const exists = gitSafe('rev-parse', '--verify', `origin/${clean}`);
  if (!exists.ok) {
    return { output: `Branch origin/${clean} does not exist on remote.`, exitCode: 1 };
  }

  // Get commits ahead of main
  const logResult = gitSafe(
    'log',
    '--oneline',
    '--reverse',
    `origin/main..origin/${clean}`,
  );
  if (!logResult.ok || !logResult.output) {
    return { output: `No commits ahead of main on ${clean}.`, exitCode: 0 };
  }

  const commits = logResult.output.split('\n');
  const shas = commits.map((c) => c.split(' ')[0]);

  log.log(`Found ${bold}${commits.length}${reset} commit(s) to recover:\n`);
  for (const c of commits) {
    log.log(`  ${dim}${c}${reset}`);
  }

  // Create a new recovery branch
  const recoveryBranch = `claude/recover-${clean.replace(/^claude\//, '')}`;
  log.log(`\nCreating recovery branch: ${green}${recoveryBranch}${reset}`);

  git('checkout', 'main');
  git('pull', 'origin', 'main');

  const branchResult = gitSafe('checkout', '-b', recoveryBranch);
  if (!branchResult.ok) {
    return { output: `Failed to create branch ${recoveryBranch}: ${branchResult.stderr}`, exitCode: 1 };
  }

  // Cherry-pick each commit
  let picked = 0;
  let conflicts = 0;
  const conflictShas: string[] = [];

  for (const sha of shas) {
    const cp = gitSafe('cherry-pick', sha);
    if (cp.ok) {
      picked++;
    } else {
      conflicts++;
      conflictShas.push(sha);
      // Abort cherry-pick and skip this commit
      gitSafe('cherry-pick', '--abort');
      log.warn(`  Conflict on ${sha} — skipped`);
    }
  }

  const lines: string[] = [];
  lines.push(`\n${bold}Recovery results:${reset}`);
  lines.push(`  ${green}Cherry-picked: ${picked}${reset}`);
  if (conflicts > 0) {
    lines.push(`  ${yellow}Skipped (conflicts): ${conflicts}${reset}`);
    lines.push(`  ${dim}Conflicting SHAs: ${conflictShas.join(', ')}${reset}`);
  }

  if (picked === 0) {
    // Nothing was recovered, clean up
    git('checkout', 'main');
    gitSafe('branch', '-D', recoveryBranch);
    lines.push(`\n${yellow}No commits could be cherry-picked. Recovery branch deleted.${reset}`);
    return { output: lines.join('\n'), exitCode: 1 };
  }

  // Push and create PR
  git('push', '-u', 'origin', recoveryBranch);

  const prBody = [
    `## Summary`,
    `Recovers ${picked} commit(s) from stale branch \`${clean}\` that were pushed after its PR was merged.`,
    '',
    conflicts > 0
      ? `${conflicts} commit(s) had conflicts and were skipped.`
      : '',
    '',
    `### Recovered commits`,
    ...commits.map((c) => `- ${c}`),
    '',
    `---`,
    `Generated by \`crux gh branches recover\``,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const pr = await githubApi<{ html_url: string; number: number }>(
      `/repos/${REPO}/pulls`,
      {
        method: 'POST',
        body: {
          title: `recover: ${clean} post-merge commits`,
          body: prBody,
          head: recoveryBranch,
          base: 'main',
        },
      },
    );
    lines.push(`\n${green}${log.successIcon} PR created: ${pr.html_url}${reset}`);
  } catch (e) {
    lines.push(
      `\n${yellow}Branch pushed but PR creation failed: ${e instanceof Error ? e.message : String(e)}${reset}`,
    );
    lines.push(
      `${dim}Create manually: gh pr create --head ${recoveryBranch}${reset}`,
    );
  }

  // Switch back to original branch
  gitSafe('checkout', '-');

  return { output: lines.join('\n'), exitCode: 0 };
}

// ── Export ────────────────────────────────────────────────────────────────────

export const commands: Record<
  string,
  (args: string[], options: CommandOptions) => Promise<CommandResult>
> = {
  status: async (args, opts) => statusCommand(),
  default: async (args, opts) => statusCommand(),
  audit: auditCommand,
  cleanup: cleanupCommand,
  recover: recoverCommand,
};
