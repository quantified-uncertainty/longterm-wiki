/**
 * Deploy Tasks Command Handlers
 *
 * Track post-deploy verification tasks — auto-detect from diffs,
 * find pending tasks from merged PRs, inject into PR descriptions.
 *
 * Usage:
 *   crux gh deploy-tasks detect             Detect deploy tasks from current branch diff
 *   crux gh deploy-tasks pending            Find unchecked tasks from recently merged PRs
 *   crux gh deploy-tasks inject             Output deploy tasks section (or update a PR)
 */

import { createLogger } from '../lib/output.ts';
import type { CommandOptions, CommandResult } from '../lib/command-types.ts';
import {
  detectDeployTasks,
  parseDeployTasksFromBody,
  formatDeployTasksSection,
} from '../lib/deploy-tasks/detect.ts';
import { githubApi, REPO } from '../lib/github.ts';

// ── detect ──────────────────────────────────────────────────────────────────

async function detect(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const baseRef = (options.base as string) || 'origin/main';

  const result = detectDeployTasks(baseRef);

  if (result.error) {
    if (options.ci) {
      return {
        output: JSON.stringify({ error: result.error }, null, 2) + '\n',
        exitCode: 1,
      };
    }
    return {
      output: `${c.red}Error:${c.reset} ${result.error}\n`,
      exitCode: 1,
    };
  }

  if (options.ci) {
    return {
      output: JSON.stringify(result, null, 2) + '\n',
      exitCode: 0,
    };
  }

  if (result.tasks.length === 0) {
    return { output: `${c.green}No deploy tasks detected.${c.reset}\n`, exitCode: 0 };
  }

  const lines: string[] = [];
  lines.push(
    `${c.bold}Deploy Tasks Detected${c.reset} (${result.tasks.length} task${result.tasks.length === 1 ? '' : 's'} from ${result.filesAnalyzed} files):\n`
  );

  // Group tasks by category
  const byCategory = new Map<string, typeof result.tasks>();
  for (const task of result.tasks) {
    if (!byCategory.has(task.category)) byCategory.set(task.category, []);
    byCategory.get(task.category)!.push(task);
  }

  for (const [category, tasks] of byCategory) {
    lines.push(`${c.cyan}${category}${c.reset}`);
    for (const task of tasks) {
      const meta = `${task.phase}, ${task.automated ? 'automated' : 'manual'}`;
      lines.push(`  ${c.yellow}\u2610${c.reset} ${task.description} ${c.dim}[${meta}]${c.reset}`);
      if (task.sourceFiles.length > 0) {
        lines.push(`    ${c.dim}Source: ${task.sourceFiles.join(', ')}${c.reset}`);
      }
    }
    lines.push('');
  }

  return { output: lines.join('\n').trimEnd() + '\n', exitCode: 0 };
}

// ── pending ─────────────────────────────────────────────────────────────────

interface PrData {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
}

function daysAgo(dateStr: string): number {
  const then = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

async function pending(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const lookbackDays = Number(options.days) || 14;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  const prs = await githubApi<PrData[]>(
    `/repos/${REPO}/pulls?state=closed&sort=created&direction=desc&per_page=30`
  );

  const pendingPrs: Array<{
    number: number;
    title: string;
    mergedDaysAgo: number;
    uncheckedTasks: string[];
  }> = [];

  for (const pr of prs) {
    if (!pr.merged_at) continue;
    const mergedDate = new Date(pr.merged_at);
    if (mergedDate < cutoff) continue;
    if (!pr.body) continue;

    const parsed = parseDeployTasksFromBody(pr.body);
    if (!parsed || parsed.unchecked === 0) continue;

    const unchecked = parsed.items.filter((t) => !t.checked).map((t) => t.text);
    pendingPrs.push({
      number: pr.number,
      title: pr.title,
      mergedDaysAgo: daysAgo(pr.merged_at),
      uncheckedTasks: unchecked,
    });
  }

  if (options.ci) {
    return {
      output: JSON.stringify({ pendingPrs, lookbackDays }, null, 2) + '\n',
      exitCode: 0,
    };
  }

  if (pendingPrs.length === 0) {
    return {
      output: `${c.green}No pending deploy tasks. All clear!${c.reset}\n`,
      exitCode: 0,
    };
  }

  const totalUnchecked = pendingPrs.reduce((sum, pr) => sum + pr.uncheckedTasks.length, 0);
  const lines: string[] = [];
  lines.push(
    `${c.bold}Pending Deploy Tasks${c.reset} (${totalUnchecked} unchecked across ${pendingPrs.length} PR${pendingPrs.length === 1 ? '' : 's'}):\n`
  );

  for (const pr of pendingPrs) {
    lines.push(
      `${c.cyan}PR #${pr.number}${c.reset} (merged ${pr.mergedDaysAgo}d ago): ${c.dim}"${pr.title}"${c.reset}`
    );
    for (const task of pr.uncheckedTasks) {
      lines.push(`  ${c.yellow}\u2610${c.reset} ${task}`);
    }
    lines.push('');
  }

  return { output: lines.join('\n').trimEnd() + '\n', exitCode: 0 };
}

// ── inject ──────────────────────────────────────────────────────────────────

async function inject(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const baseRef = (options.base as string) || 'origin/main';
  const prNumber = options.pr ? Number(options.pr) : null;

  const result = detectDeployTasks(baseRef);

  if (result.error) {
    return {
      output: `${c.red}Error:${c.reset} ${result.error}\n`,
      exitCode: 1,
    };
  }

  const section = formatDeployTasksSection(result.tasks);

  if (!prNumber) {
    return { output: section + '\n', exitCode: 0 };
  }

  // Fetch current PR body and update it
  const pr = await githubApi<{ body: string | null }>(
    `/repos/${REPO}/pulls/${prNumber}`
  );
  let body = pr.body || '';

  const startMarker = '<!-- deploy-tasks:v1 -->';
  const endMarker = '<!-- /deploy-tasks -->';
  const startIdx = body.indexOf(startMarker);
  const endIdx = body.indexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing section (including ## Deploy Checklist header if present)
    let sectionStart = startIdx;
    const beforeMarker = body.slice(0, startIdx);
    const headerIdx = beforeMarker.lastIndexOf('## Deploy Checklist');
    if (headerIdx !== -1) {
      sectionStart = headerIdx;
    }
    body = body.slice(0, sectionStart) + section + body.slice(endIdx + endMarker.length);
  } else {
    // Append before last --- separator or at end
    const lastSepIdx = body.lastIndexOf('\n---');
    if (lastSepIdx !== -1) {
      body = body.slice(0, lastSepIdx) + '\n\n' + section + body.slice(lastSepIdx);
    } else {
      body = body + '\n\n' + section;
    }
  }

  await githubApi(`/repos/${REPO}/pulls/${prNumber}`, {
    method: 'PATCH',
    body: { body },
  });

  return {
    output: `${c.green}✓${c.reset} Updated PR #${prNumber} with deploy tasks section.\n\n${section}\n`,
    exitCode: 0,
  };
}

// ── exports ─────────────────────────────────────────────────────────────────

export const commands = {
  detect,
  pending,
  inject,
};

export function getHelp(): string {
  return `Deploy Tasks — Track post-deploy verification tasks

Commands:
  detect                Detect deploy tasks from current branch diff.
  pending               Find unchecked deploy tasks from recently merged PRs.
  inject                Inject deploy tasks section into a PR description.

Options (detect):
  --base=<ref>          Base ref for diff (default: origin/main).
  --ci                  JSON output.

Options (pending):
  --days=N              Lookback window in days (default: 14).
  --ci                  JSON output.

Options (inject):
  --pr=N                Update PR #N's description (otherwise prints to stdout).
  --base=<ref>          Base ref for diff (default: origin/main).

Examples:
  pnpm crux gh deploy-tasks detect                # Show tasks for current branch
  pnpm crux gh deploy-tasks pending               # Show unchecked tasks from recent PRs
  pnpm crux gh deploy-tasks inject --pr=3270      # Add tasks section to PR #3270`;
}
