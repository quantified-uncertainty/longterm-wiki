/**
 * Release Command Handlers
 *
 * Creates (or updates) a PR from main → production with a standardized title
 * and auto-generated changelog. Merging the resulting PR triggers production
 * deploys (Vercel frontend + wiki-server via wiki-server-docker.yml).
 *
 * Usage:
 *   crux release create             Create or update a release PR
 *   crux release create --dry-run   Preview without creating
 */

import { execFileSync } from 'child_process';
import { createLogger } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';
import type { CommandOptions, CommandResult } from '../lib/command-types.ts';

// ── Types ────────────────────────────────────────────────────────────────────

interface GitHubPR {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  head: { ref: string };
  base: { ref: string };
}

interface GitHubLabel {
  id: number;
  name: string;
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf-8' }).trim();
}

/**
 * Count commits reachable from `to` but not from `from`.
 * Equivalent to `git rev-list --count from..to`.
 */
function commitCount(from: string, to: string): number {
  const count = git('rev-list', '--count', `${from}..${to}`);
  return parseInt(count, 10);
}

/**
 * Get commit subjects between two refs (excluding merges).
 */
function commitSubjects(from: string, to: string): string[] {
  const output = git('log', `${from}..${to}`, '--format=%s', '--no-merges');
  if (!output) return [];
  return output.split('\n').filter(Boolean);
}

// ── Changelog generation ─────────────────────────────────────────────────────

type CommitCategory = 'features' | 'fixes' | 'refactoring' | 'docs' | 'infrastructure' | 'other';

const CATEGORY_LABELS: Record<CommitCategory, string> = {
  features: 'Features',
  fixes: 'Fixes',
  refactoring: 'Refactoring',
  docs: 'Documentation',
  infrastructure: 'Infrastructure',
  other: 'Other',
};

/**
 * Categorize a commit message by its conventional-commit prefix.
 */
export function categorizeCommit(subject: string): CommitCategory {
  if (subject.startsWith('feat')) return 'features';
  if (subject.startsWith('fix')) return 'fixes';
  if (subject.startsWith('refactor')) return 'refactoring';
  if (subject.startsWith('docs')) return 'docs';
  if (/^(chore|ci|build|perf)/.test(subject)) return 'infrastructure';
  return 'other';
}

/**
 * Group commit subjects by category.
 */
export function groupCommits(subjects: string[]): Record<CommitCategory, string[]> {
  const groups: Record<CommitCategory, string[]> = {
    features: [],
    fixes: [],
    refactoring: [],
    docs: [],
    infrastructure: [],
    other: [],
  };

  for (const subject of subjects) {
    const category = categorizeCommit(subject);
    groups[category].push(subject);
  }

  return groups;
}

/**
 * Generate a release PR body from commit data.
 */
export function generateReleaseBody(opts: {
  date: string;
  ahead: number;
  behind: number;
  subjects: string[];
  repoSlug: string;
}): string {
  const { date, ahead, behind, subjects, repoSlug } = opts;
  const groups = groupCommits(subjects);
  const lines: string[] = [];

  lines.push(`## Release ${date}`);
  lines.push('');
  lines.push(`**${ahead} commits** since last release.`);
  lines.push('');

  // Divergence warning
  if (behind > 0) {
    lines.push('> [!WARNING]');
    lines.push(`> Production has **${behind} commits** not on main (hotfixes or merge commits).`);
    lines.push('> Review carefully to ensure these won\'t be overwritten.');
    lines.push('');
  }

  // Grouped changelog
  const categoryOrder: CommitCategory[] = [
    'features', 'fixes', 'refactoring', 'docs', 'infrastructure', 'other',
  ];

  for (const category of categoryOrder) {
    const items = groups[category];
    if (items.length > 0) {
      lines.push(`### ${CATEGORY_LABELS[category]}`);
      for (const item of items) {
        lines.push(`- ${item}`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`[Full diff](https://github.com/${repoSlug}/compare/production...main)`);

  return lines.join('\n');
}

/**
 * Determine the release title, handling same-day numbering.
 *
 * Checks for already-merged release PRs from today. If one exists,
 * appends "#2", "#3", etc.
 */
export async function determineTitle(date: string): Promise<string> {
  const baseTitle = `release: ${date}`;

  // Check for already-merged release PRs from today
  const mergedPRs = await githubApi<Array<{ title: string }>>(
    `/repos/${REPO}/pulls?base=production&state=closed&sort=updated&direction=desc&per_page=30`
  );

  const mergedToday = mergedPRs.filter(
    (pr) => pr.title.startsWith(`release: ${date}`)
  ).length;

  if (mergedToday > 0) {
    return `${baseTitle} #${mergedToday + 1}`;
  }

  return baseTitle;
}

// ── Label management ─────────────────────────────────────────────────────────

const RELEASE_LABEL = '0-release';

async function ensureLabel(): Promise<void> {
  try {
    await githubApi<GitHubLabel>(`/repos/${REPO}/labels/${RELEASE_LABEL}`);
  } catch {
    // Label doesn't exist — create it
    await githubApi<GitHubLabel>(`/repos/${REPO}/labels`, {
      method: 'POST',
      body: {
        name: RELEASE_LABEL,
        description: 'Production release PR',
        color: '0E8A16',
      },
    });
  }
}

// ── Main command ─────────────────────────────────────────────────────────────

/**
 * Create or update a release PR from main → production.
 *
 * Options:
 *   --dry-run    Preview what would happen without creating/updating the PR.
 */
async function create(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const dryRun = Boolean(options.dryRun ?? options['dry-run']);

  // Fetch latest remote refs
  git('fetch', 'origin', 'main', 'production');

  // Check for changes
  const ahead = commitCount('origin/production', 'origin/main');
  const behind = commitCount('origin/main', 'origin/production');

  if (ahead === 0) {
    return {
      output: `${c.dim}No new commits on main since last release. Nothing to do.${c.reset}\n`,
      exitCode: 0,
    };
  }

  // Generate changelog
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
  const subjects = commitSubjects('origin/production', 'origin/main');
  const body = generateReleaseBody({
    date,
    ahead,
    behind,
    subjects,
    repoSlug: REPO,
  });

  // Determine title (handles same-day numbering)
  const title = await determineTitle(date);

  if (dryRun) {
    let output = `${c.green}Dry run — would create/update release PR:${c.reset}\n\n`;
    output += `  Title: ${title}\n`;
    output += `  Ahead: ${ahead} commits\n`;
    output += `  Behind: ${behind} commits\n\n`;
    output += `--- PR body preview ---\n${body}\n`;
    return { output, exitCode: 0 };
  }

  // Ensure label exists before creating PR
  await ensureLabel();

  // Check for existing open release PR
  const [repoOwner] = REPO.split('/');
  const existingPRs = await githubApi<GitHubPR[]>(
    `/repos/${REPO}/pulls?base=production&head=${repoOwner}:main&state=open`
  );

  if (existingPRs.length > 0) {
    // Update existing PR
    const pr = existingPRs[0];
    await githubApi<GitHubPR>(`/repos/${REPO}/pulls/${pr.number}`, {
      method: 'PATCH',
      body: { title, body },
    });

    return {
      output:
        `${c.green}✓${c.reset} Updated release PR #${pr.number}\n` +
        `  Title: ${title}\n` +
        `  ${pr.html_url}\n` +
        `  ${c.yellow}Merge with "Create a merge commit" — never squash.${c.reset}\n`,
      exitCode: 0,
    };
  }

  // Create new PR
  const pr = await githubApi<GitHubPR>(`/repos/${REPO}/pulls`, {
    method: 'POST',
    body: {
      title,
      body,
      head: 'main',
      base: 'production',
    },
  });

  // Add label
  try {
    await githubApi(`/repos/${REPO}/issues/${pr.number}/labels`, {
      method: 'POST',
      body: { labels: [RELEASE_LABEL] },
    });
  } catch (e: unknown) {
    // Non-critical — log and continue
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`Failed to add '${RELEASE_LABEL}' label: ${msg}`);
  }

  return {
    output:
      `${c.green}✓${c.reset} Created release PR #${pr.number}\n` +
      `  Title: ${title}\n` +
      `  ${pr.html_url}\n` +
      `  ${c.yellow}Merge with "Create a merge commit" — never squash.${c.reset}\n`,
    exitCode: 0,
  };
}

// ── Domain exports ───────────────────────────────────────────────────────────

export const commands = {
  create,
};

export function getHelp(): string {
  return `
Release Domain — Production release management

Commands:
  create                Create or update a release PR (main → production).

Options (create):
  --dry-run             Preview what would happen without creating/updating the PR.
  --ci                  JSON output for CI pipelines.

The release PR includes:
  - Standardized title: "release: YYYY-MM-DD" (or "#2" for same-day re-releases)
  - Auto-generated changelog grouped by conventional commit type
  - Divergence warning if production has hotfix commits not on main
  - Idempotent: updates existing open release PR instead of creating duplicates

Examples:
  pnpm crux release create               # Create or update release PR
  pnpm crux release create --dry-run     # Preview without creating
`.trim();
}
