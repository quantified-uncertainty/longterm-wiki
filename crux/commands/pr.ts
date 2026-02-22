/**
 * PR Command Handlers
 *
 * Utilities for managing GitHub Pull Requests associated with the current branch.
 *
 * Usage:
 *   crux pr create             Create a PR for the current branch (corruption-safe)
 *   crux pr detect             Detect open PR for current branch (returns PR URL + number)
 *   crux pr fix-body           Detect and repair literal \n in the current branch's PR body
 *   crux pr fix-body --pr=N    Target a specific PR number instead of auto-detecting
 */

import { createLogger } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';
import { currentBranch } from '../lib/session-checklist.ts';
import type { CommandResult } from '../lib/cli.ts';

type CommandOptions = Record<string, unknown>;

interface GitHubPR {
  number: number;
  html_url: string;
  body: string | null;
  head: { ref: string };
  base: { ref: string };
}

/**
 * Detect the open PR for the current branch.
 *
 * Returns the PR number and URL if found, or a clear message if not.
 * Useful for scripts and skill files that need to know if a PR exists.
 */
async function detect(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;

  const branch = currentBranch();
  const prs = await githubApi<GitHubPR[]>(
    `/repos/${REPO}/pulls?head=quantified-uncertainty:${branch}&state=open`
  );

  if (!prs.length) {
    if (options.ci) {
      return { output: JSON.stringify({ found: false, branch }) + '\n', exitCode: 1 };
    }
    return {
      output: `${c.yellow}No open PR found for branch ${branch}.${c.reset}\n`,
      exitCode: 1,
    };
  }

  const pr = prs[0];
  if (options.ci) {
    return {
      output: JSON.stringify({ found: true, number: pr.number, url: pr.html_url, branch }) + '\n',
      exitCode: 0,
    };
  }

  return {
    output: `${c.green}✓${c.reset} PR #${pr.number}: ${pr.html_url}\n`,
    exitCode: 0,
  };
}

/**
 * Create a PR for the current branch (corruption-safe).
 *
 * All string fields are passed through githubApi() which validates for
 * shell-expansion corruption before sending. This is the safe alternative
 * to constructing curl commands with jq in bash.
 *
 * Options:
 *   --title="PR title"      Required. Title for the PR.
 *   --body="PR body"        Required. Markdown body for the PR.
 *   --base=main             Base branch (default: main).
 *   --draft                 Create as draft PR.
 *
 * If a PR already exists for this branch, reports it instead of creating a duplicate.
 */
async function create(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;

  const branch = currentBranch();
  const title = options.title as string | undefined;
  const body = options.body as string | undefined;
  const base = (options.base as string) || 'main';
  const draft = Boolean(options.draft);

  if (!title) {
    return {
      output: `${c.red}Usage: crux pr create --title="PR title" --body="PR body" [--base=main] [--draft]${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Check for existing PR first
  const existing = await githubApi<GitHubPR[]>(
    `/repos/${REPO}/pulls?head=quantified-uncertainty:${branch}&state=open`
  );

  if (existing.length > 0) {
    const pr = existing[0];
    return {
      output:
        `${c.yellow}PR already exists for branch ${branch}:${c.reset}\n` +
        `  PR #${pr.number}: ${pr.html_url}\n` +
        `  ${c.dim}Use \`crux pr fix-body\` to update the body if needed.${c.reset}\n`,
      exitCode: 0,
    };
  }

  const pr = await githubApi<GitHubPR>(`/repos/${REPO}/pulls`, {
    method: 'POST',
    body: {
      title,
      body: body || '',
      head: branch,
      base,
      draft,
    },
  });

  let output = `${c.green}✓${c.reset} Created PR #${pr.number}: ${pr.html_url}\n`;
  if (draft) output += `  ${c.dim}(draft)${c.reset}\n`;

  return { output, exitCode: 0 };
}

/**
 * Detect and auto-fix literal \n sequences in a PR body.
 *
 * Root cause: agents fill PR_BODY using bash double-quoted strings with \n
 * escape sequences. Bash does NOT expand \n in double-quoted strings —
 * it passes literal backslash+n to jq, which serializes them as \\n in JSON.
 * GitHub renders these as visible \n in the PR description.
 *
 * This command fetches the PR for the current branch, checks for literal \n,
 * and patches the body via PATCH /pulls/:number if needed.
 *
 * Exit codes: 0 = clean or fixed, 1 = error (API failure, no token, no PR)
 */
async function fixBody(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;

  // Determine PR number
  let prNum: number | null = options.pr ? parseInt(String(options.pr), 10) : null;

  if (!prNum) {
    const branch = currentBranch();
    const prs = await githubApi<GitHubPR[]>(
      `/repos/${REPO}/pulls?head=quantified-uncertainty:${branch}&state=open`
    );
    if (!prs.length) {
      return {
        output: `${c.yellow}No open PR found for branch ${branch}. Nothing to check.${c.reset}\n`,
        exitCode: 0,
      };
    }
    prNum = prs[0].number;
  }

  const pr = await githubApi<GitHubPR>(`/repos/${REPO}/pulls/${prNum}`);
  const body = pr.body ?? '';

  // Check for literal \n (two characters: backslash + n) that aren't in a code block.
  // A simple heuristic: if the string contains the two-char sequence \n (not a real newline),
  // the body was malformed. We detect this by checking the raw string from the API.
  if (!body.includes('\\n')) {
    return {
      output: `${c.green}✓ PR #${prNum} body looks clean (no literal \\n found).${c.reset}\n`,
      exitCode: 0,
    };
  }

  // Count how many literal \n sequences exist for the report
  const count = (body.match(/\\n/g) ?? []).length;

  log.info(`⚠️  PR #${prNum} body has ${count} literal \\n sequence(s). Auto-fixing...`);

  const fixed = body.replace(/\\n/g, '\n');

  await githubApi<GitHubPR>(`/repos/${REPO}/pulls/${prNum}`, {
    method: 'PATCH',
    body: { body: fixed },
  });

  return {
    output:
      `${c.green}✓ PR #${prNum} body fixed — replaced ${count} literal \\n with real newlines.${c.reset}\n` +
      `  ${pr.html_url}\n`,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// Domain entry point (required by crux.mjs dispatch)
// ---------------------------------------------------------------------------

export const commands = {
  create,
  detect,
  'fix-body': fixBody,
};

export function getHelp(): string {
  return `
PR Domain — GitHub Pull Request utilities

Commands:
  create              Create a PR for the current branch (corruption-safe).
  detect              Detect open PR for current branch (returns URL + number).
  fix-body [--pr=N]   Detect and repair literal \\n in the current branch's PR body.

Options (create):
  --title="..."       Required. PR title.
  --body="..."        Required. PR body (markdown).
  --base=main         Base branch (default: main).
  --draft             Create as draft PR.

Options (detect):
  --ci                JSON output.

Options (fix-body):
  --pr=N              Target a specific PR number instead of auto-detecting.

Examples:
  pnpm crux pr create --title="Add feature X" --body="## Summary\\n- Added X"
  pnpm crux pr detect                    # Check if PR exists for this branch
  pnpm crux pr detect --ci               # JSON output for scripts
  pnpm crux pr fix-body                  # Fix PR for current branch
  pnpm crux pr fix-body --pr=42          # Fix a specific PR
`.trim();
}
