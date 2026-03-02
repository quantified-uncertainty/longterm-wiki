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

import { readFileSync } from 'fs';
import { createLogger } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';
import { currentBranch } from '../lib/session/session-checklist.ts';
import type { CommandResult } from '../lib/cli.ts';

type CommandOptions = Record<string, unknown>;

// ── Test plan validation ─────────────────────────────────────────────────────

export interface TestPlanValidation {
  hasTestPlanSection: boolean;
  totalItems: number;
  checkedItems: number;
  uncheckedItems: number;
  status: 'ok' | 'warn' | 'block';
  message: string;
}

/**
 * Validate the test plan section in a PR body.
 *
 * Rules:
 * - A "## Test plan" section must exist (blocks if missing).
 * - Test plan must have at least one checkbox item (blocks if empty).
 * - All checkbox items should be checked (warns if unchecked items remain).
 *   Unchecked items mean testing was planned but not executed.
 */
export function validateTestPlan(body: string): TestPlanValidation {
  // Find the test plan section (case-insensitive, allow ## or ###)
  const testPlanMatch = body.match(/^#{2,3}\s+test\s+plan\b/im);

  if (!testPlanMatch) {
    return {
      hasTestPlanSection: false,
      totalItems: 0,
      checkedItems: 0,
      uncheckedItems: 0,
      status: 'block',
      message: 'PR body is missing a "## Test plan" section.',
    };
  }

  // Extract the test plan section content (up to next ## heading or end of body)
  const sectionStart = testPlanMatch.index! + testPlanMatch[0].length;
  const nextHeading = body.slice(sectionStart).match(/^#{2,3}\s+/m);
  const sectionEnd = nextHeading
    ? sectionStart + nextHeading.index!
    : body.length;
  const section = body.slice(sectionStart, sectionEnd);

  // Count checkbox items
  const checked = [...section.matchAll(/^[\s]*-\s+\[x\]/gim)];
  const unchecked = [...section.matchAll(/^[\s]*-\s+\[\s\]/gm)];
  const totalItems = checked.length + unchecked.length;

  if (totalItems === 0) {
    return {
      hasTestPlanSection: true,
      totalItems: 0,
      checkedItems: 0,
      uncheckedItems: 0,
      status: 'block',
      message: 'Test plan section exists but has no checkbox items (- [ ] or - [x]).',
    };
  }

  if (unchecked.length > 0 && checked.length === 0) {
    return {
      hasTestPlanSection: true,
      totalItems,
      checkedItems: checked.length,
      uncheckedItems: unchecked.length,
      status: 'block',
      message: `Test plan has ${unchecked.length} item(s) but none are checked. Tests were listed but not executed.`,
    };
  }

  if (unchecked.length > 0) {
    return {
      hasTestPlanSection: true,
      totalItems,
      checkedItems: checked.length,
      uncheckedItems: unchecked.length,
      status: 'warn',
      message: `Test plan has ${unchecked.length} unchecked item(s) out of ${totalItems}. Consider completing or removing unexecuted items.`,
    };
  }

  return {
    hasTestPlanSection: true,
    totalItems,
    checkedItems: checked.length,
    uncheckedItems: 0,
    status: 'ok',
    message: `Test plan: ${checked.length}/${totalItems} items verified.`,
  };
}

/**
 * Bigram Jaccard similarity between two text strings.
 * Returns 0.0 (no overlap) to 1.0 (identical).
 * Used to detect copy-pasted PR descriptions.
 */
export function bigramSimilarity(a: string, b: string): number {
  const toBigrams = (s: string): Set<string> => {
    const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    const set = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) {
      set.add(`${words[i]} ${words[i + 1]}`);
    }
    return set;
  };

  const setA = toBigrams(a);
  const setB = toBigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const bg of setA) {
    if (setB.has(bg)) intersection++;
  }

  return intersection / (setA.size + setB.size - intersection);
}

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
 *   --body="PR body"        Body as inline string (vulnerable to shell expansion).
 *   --body-file=<path>      Body from a file (safe for markdown with backticks).
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
  const bodyFile = (options.bodyFile ?? options['body-file']) as string | undefined;
  let body = options.body as string | undefined;
  const base = (options.base as string) || 'main';
  const draft = Boolean(options.draft);

  // --body-file takes precedence (avoids shell expansion of backticks in markdown)
  if (bodyFile) {
    try {
      body = readFileSync(bodyFile, 'utf-8');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        output: `${c.red}Error reading --body-file: ${msg}${c.reset}\n`,
        exitCode: 1,
      };
    }
  }

  // If no body provided and stdin is a pipe (not a TTY), read body from stdin.
  // This allows: pnpm crux pr create --title="..." <<'EOF'\nbody\nEOF
  // Avoids sh/dash heredoc-in-command-substitution incompatibilities (#722 paranoid review).
  //
  // IMPORTANT: In non-interactive environments (Claude Code Bash tool, GitHub Actions),
  // process.stdin.isTTY is undefined even without a pipe. readFileSync('/dev/stdin')
  // returns "" immediately in these environments. We must discard empty stdin reads,
  // otherwise every `crux pr create` call without explicit body silently creates an
  // empty-description PR.
  if (!body && !process.stdin.isTTY) {
    const { readFileSync: readFdSync } = await import('fs');
    try {
      const stdinContent = readFdSync('/dev/stdin', 'utf-8');
      if (stdinContent.trim()) {
        body = stdinContent;
      }
    } catch {
      // stdin not readable — leave body undefined
    }
  }

  // Block empty PR descriptions unless explicitly opted in (#816).
  // Silent empty descriptions were the #1 PR quality problem — 33% of recent PRs had empty bodies.
  if (!body || !body.trim()) {
    if (options.allowEmptyBody ?? options['allow-empty-body']) {
      log.warn('Creating PR with empty body (--allow-empty-body).');
    } else {
      return {
        output:
          `${c.red}Error: No PR body provided.${c.reset}\n` +
          `  PRs with empty descriptions cannot be reviewed or audited.\n` +
          `  Provide a body using one of:\n` +
          `    --body-file=<path>          (recommended for multi-line)\n` +
          `    --body="short description"  (single line)\n` +
          `    stdin heredoc:  pnpm crux pr create --title="..." <<'PRBODY'\\n## Summary\\nPRBODY\n` +
          `  Or pass --allow-empty-body to force creation without a description.\n`,
        exitCode: 1,
      };
    }
  }

  if (!title) {
    return {
      output: `${c.red}Usage: crux pr create --title="PR title" --body="PR body" [--body-file=<path>] [--base=main] [--draft]${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Quality checks on PR body: dedup (#819) and copy-paste detection
  if (body) {
    try {
      const recentPRs = await githubApi<Array<{ number: number; title: string; body: string | null; merged_at: string | null }>>(
        `/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=20`
      );
      const recentMerged = recentPRs.filter(pr => pr.merged_at);

      // Check 1: Dedup — warn if Closes #N overlaps with recently merged PRs (#819)
      const closesRefs = [...body.matchAll(/(?:Closes|Fixes|Resolves)\s+#(\d+)/gi)].map(m => parseInt(m[1], 10));
      for (const ref of closesRefs) {
        const overlap = recentMerged.find(pr =>
          pr.body && new RegExp(`(?:Closes|Fixes|Resolves)\\s+#${ref}\\b`, 'i').test(pr.body)
        );
        if (overlap) {
          log.warn(
            `Issue #${ref} was already closed by PR #${overlap.number} ("${overlap.title}"). ` +
            `This may be a duplicate fix.`
          );
        }
      }

      // Check 2: Copy-paste detection — warn if body is suspiciously similar to a recent PR
      for (const pr of recentMerged) {
        if (!pr.body || pr.body.trim().length < 50) continue;
        const sim = bigramSimilarity(body, pr.body);
        if (sim >= 0.6) {
          log.warn(
            `PR body is ${Math.round(sim * 100)}% similar to recently merged PR #${pr.number} ("${pr.title}"). ` +
            `This may be a copy-pasted description from the wrong PR.`
          );
        }
      }
    } catch {
      // Quality checks are best-effort — don't block PR creation if they fail
    }

    // Check 3: Test plan validation
    if (!(options.skipTestPlan ?? options['skip-test-plan'])) {
      const testPlanResult = validateTestPlan(body);
      if (testPlanResult.status === 'block') {
        return {
          output:
            `${c.red}✗ Test plan validation failed:${c.reset} ${testPlanResult.message}\n` +
            `  PRs must include a "## Test plan" section with checked items (- [x]).\n` +
            `  Pass --skip-test-plan to bypass this check.\n`,
          exitCode: 1,
        };
      }
      if (testPlanResult.status === 'warn') {
        log.warn(testPlanResult.message);
      } else {
        log.info(testPlanResult.message);
      }
    }
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

/**
 * Validate the test plan section of the current branch's PR.
 *
 * Reads the PR body from GitHub and checks that the test plan section
 * has checkbox items and that they are checked (indicating tests were executed).
 *
 * Options:
 *   --pr=N    Target a specific PR number instead of auto-detecting
 *   --json    JSON output
 */
async function validateTestPlanCmd(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const json = Boolean(options.json);

  let prNum: number | null = options.pr ? parseInt(String(options.pr), 10) : null;

  if (!prNum) {
    const branch = currentBranch();
    const prs = await githubApi<GitHubPR[]>(
      `/repos/${REPO}/pulls?head=quantified-uncertainty:${branch}&state=open`
    );
    if (!prs.length) {
      if (json) return { output: JSON.stringify({ error: 'no PR found' }) + '\n', exitCode: 1 };
      return {
        output: `${c.yellow}No open PR found for branch ${currentBranch()}.${c.reset}\n`,
        exitCode: 1,
      };
    }
    prNum = prs[0].number;
  }

  const pr = await githubApi<GitHubPR>(`/repos/${REPO}/pulls/${prNum}`);
  const result = validateTestPlan(pr.body ?? '');

  if (json) {
    return { output: JSON.stringify({ pr: prNum, ...result }) + '\n', exitCode: result.status === 'block' ? 1 : 0 };
  }

  const icon = result.status === 'ok' ? `${c.green}✓` : result.status === 'warn' ? `${c.yellow}⚠` : `${c.red}✗`;
  return {
    output: `${icon}${c.reset} PR #${prNum}: ${result.message}\n`,
    exitCode: result.status === 'block' ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Domain entry point (required by crux.mjs dispatch)
// ---------------------------------------------------------------------------

export const commands = {
  create,
  detect,
  'fix-body': fixBody,
  'validate-test-plan': validateTestPlanCmd,
};

export function getHelp(): string {
  return `
PR Domain — GitHub Pull Request utilities

Commands:
  create                        Create a PR for the current branch (corruption-safe).
  detect                        Detect open PR for current branch (returns URL + number).
  fix-body [--pr=N]             Detect and repair literal \\n in the current branch's PR body.
  validate-test-plan [--pr=N]   Check that the PR's test plan section is complete.

Options (create):
  --title="..."       Required. PR title.
  --body="..."        PR body (inline — avoid for multi-line bodies; use --body-file or stdin).
  --body-file=<path>  PR body from file (safe for markdown with backticks).
  --base=main         Base branch (default: main).
  --draft             Create as draft PR.
  --allow-empty-body  Allow creating PR without a description (not recommended).
  --skip-test-plan    Skip test plan validation (not recommended).
  (stdin)             If --body and --body-file are absent and stdin is a pipe, body is read from stdin.

Options (detect):
  --ci                JSON output.

Options (fix-body / validate-test-plan):
  --pr=N              Target a specific PR number instead of auto-detecting.
  --json              JSON output (validate-test-plan only).

Examples:
  # Multi-line body via heredoc (recommended — avoids sh/dash heredoc issues):
  pnpm crux pr create --title="Add feature X" <<'EOF'
  ## Summary
  - Added X

  ## Test plan
  - [x] Ran unit tests
  EOF

  # Multi-line body via file (also recommended):
  pnpm crux pr create --title="Add feature X" --body-file=/tmp/pr-body.md

  # Short single-line body inline:
  pnpm crux pr create --title="Fix typo" --body="Fix typo in docs"

  pnpm crux pr detect                    # Check if PR exists for this branch
  pnpm crux pr detect --ci               # JSON output for scripts
  pnpm crux pr fix-body                  # Fix PR for current branch
  pnpm crux pr fix-body --pr=42          # Fix a specific PR
  pnpm crux pr validate-test-plan        # Check test plan on current PR
  pnpm crux pr validate-test-plan --pr=42 --json  # Check specific PR (JSON)
`.trim();
}
