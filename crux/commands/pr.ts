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
 * Normalize comma-separated Closes/Fixes/Resolves syntax to one-per-line (#632).
 *
 * GitHub unreliably handles "Closes #1, #2, #3" — often only the first issue
 * is closed. This rewrites them to the reliable one-per-line format:
 *   Closes #1
 *   Closes #2
 *   Closes #3
 */
export function normalizeClosesSyntax(body: string): { result: string; fixed: number } {
  let fixed = 0;
  const result = body.replace(
    /^((?:Closes|Fixes|Resolves)\s+#\d+)(?:(?:,\s*|\s+and\s+)(?:#?\d+))+/gim,
    (match, _first) => {
      // Extract the keyword and all issue numbers
      const keywordMatch = match.match(/^(Closes|Fixes|Resolves)/i);
      if (!keywordMatch) return match;
      const keyword = keywordMatch[1];
      const numbers = [...match.matchAll(/#?(\d+)/g)].map(m => m[1]);
      if (numbers.length <= 1) return match;
      fixed++;
      return numbers.map(n => `${keyword} #${n}`).join('\n');
    }
  );
  return { result, fixed };
}

/**
 * Detect and auto-fix issues in a PR body:
 * 1. Literal \n sequences (from bash double-quoted strings)
 * 2. Comma-separated Closes/Fixes/Resolves syntax (#632)
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
  let body = pr.body ?? '';
  const fixes: string[] = [];

  // Fix 1: Literal \n sequences
  const literalNewlineCount = (body.match(/\\n/g) ?? []).length;
  if (literalNewlineCount > 0) {
    body = body.replace(/\\n/g, '\n');
    fixes.push(`replaced ${literalNewlineCount} literal \\n with real newlines`);
  }

  // Fix 2: Comma-separated Closes syntax
  const { result: normalizedBody, fixed: closesFixed } = normalizeClosesSyntax(body);
  if (closesFixed > 0) {
    body = normalizedBody;
    fixes.push(`normalized ${closesFixed} comma-separated Closes line(s) to one-per-line`);
  }

  if (fixes.length === 0) {
    return {
      output: `${c.green}✓ PR #${prNum} body looks clean.${c.reset}\n`,
      exitCode: 0,
    };
  }

  await githubApi<GitHubPR>(`/repos/${REPO}/pulls/${prNum}`, {
    method: 'PATCH',
    body: { body },
  });

  let output = `${c.green}✓ PR #${prNum} body fixed:${c.reset}\n`;
  for (const f of fixes) {
    output += `  - ${f}\n`;
  }
  output += `  ${pr.html_url}\n`;

  return { output, exitCode: 0 };
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
