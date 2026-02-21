/**
 * PR Command Handlers
 *
 * Utilities for managing GitHub Pull Requests associated with the current branch.
 *
 * Usage:
 *   crux pr fix-body          Detect and repair literal \n in the current branch's PR body
 *   crux pr fix-body --pr=N   Target a specific PR number instead of auto-detecting
 */

import { createLogger } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';
import { currentBranch } from '../lib/session-checklist.ts';
import type { CommandResult } from '../lib/cli.ts';

interface GitHubPR {
  number: number;
  html_url: string;
  body: string | null;
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
async function fixBody(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci);
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
  'fix-body': fixBody,
};

export function getHelp(): string {
  return `
PR Domain — GitHub Pull Request utilities

Commands:
  fix-body [--pr=N]   Detect and repair literal \\n in the current branch's PR body.
                      Auto-detects the open PR for the current branch unless --pr=N given.
                      Exits 0 whether clean or fixed (safe to use as a verifyCommand).

Examples:
  pnpm crux pr fix-body          # Fix PR for current branch
  pnpm crux pr fix-body --pr=42  # Fix a specific PR
`.trim();
}
