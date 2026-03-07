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
 *   crux pr rebase-all         Rebase all open non-draft PRs onto main (CI usage)
 *   crux pr resolve-conflicts  Find and resolve all conflicted PRs
 */

import { readFileSync } from 'fs';
import { createLogger } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';
import { currentBranch } from '../lib/session/session-checklist.ts';
import { rebaseAllPrs } from '../lib/pr-rebase.ts';
import { resolveAllConflicts } from '../lib/conflict-resolution.ts';
import type { CommandOptions, CommandResult } from '../lib/command-types.ts';

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
 *   --draft                 Create as draft PR (default: true).
 *   --no-draft              Create as ready PR (not draft).
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
  // Default to draft unless --no-draft is explicitly passed
  const draft = options.noDraft === true || options['no-draft'] === true ? false : true;

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

/**
 * Rebase all open non-draft PRs onto main.
 *
 * Fetches open PRs targeting main, applies 4 safeguards to skip active work,
 * then rebases and force-pushes each eligible PR.
 *
 * Options:
 *   --verbose   Print detailed progress for each PR
 */
async function rebaseAll(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const verbose = Boolean(options.verbose);

  const { results, failed } = await rebaseAllPrs({ verbose });

  if (results.length === 0) {
    return {
      output: `${c.dim}No open non-draft PRs to rebase.${c.reset}\n`,
      exitCode: 0,
    };
  }

  let output = '';
  for (const r of results) {
    const icon =
      r.status === 'rebased'
        ? `${c.green}✓${c.reset}`
        : r.status === 'up-to-date'
          ? `${c.dim}=${c.reset}`
          : r.status === 'skipped'
            ? `${c.yellow}-${c.reset}`
            : r.status === 'conflict'
              ? `${c.yellow}!${c.reset}`
              : `${c.red}✗${c.reset}`;

    output += `  ${icon} PR #${r.number} (${r.branch}): ${r.status}`;
    if (r.reason) {
      output += ` — ${r.reason}`;
    }
    output += '\n';
  }

  const rebased = results.filter((r) => r.status === 'rebased').length;
  const upToDate = results.filter((r) => r.status === 'up-to-date').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const conflicts = results.filter((r) => r.status === 'conflict').length;
  const pushFailed = results.filter((r) => r.status === 'push-failed').length;

  output += `\n${c.bold}Summary:${c.reset} ${rebased} rebased, ${upToDate} up-to-date, ${skipped} skipped, ${conflicts} conflicts, ${pushFailed} push-failed\n`;

  if (failed > 0) {
    output += `${c.red}${failed} PR(s) failed to push — they may need manual attention or will be retried on next run.${c.reset}\n`;
  }

  return { output, exitCode: failed > 0 ? 1 : 0 };
}

/**
 * Find and resolve all open PRs with merge conflicts.
 *
 * Two-tier resolution:
 *   1. Sonnet API — fast text-level conflict resolution
 *   2. Claude Code CLI — agentic escalation for validation failures
 *
 * Options:
 *   --verbose    Show detailed output
 */
async function resolveConflictsCmd(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const verbose = Boolean(options.verbose);
  const { results, failed } = await resolveAllConflicts({ verbose });

  if (results.length === 0) {
    return { output: 'No conflicted PRs found.\n', exitCode: 0 };
  }

  let output = '';
  for (const r of results) {
    let icon: string;
    switch (r.status) {
      case 'resolved':
        icon = '\u2713'; // checkmark
        break;
      case 'skipped-fingerprint':
        icon = '\u2298'; // circled dash
        break;
      default:
        icon = '\u2717'; // X mark
    }
    output += `${icon} PR #${r.number} (${r.branch}): ${r.status}`;
    if (r.tier) output += ` [Tier ${r.tier}]`;
    output += '\n';
  }

  output += `\n${results.length} PR(s) processed, ${failed} failed.\n`;

  return { output, exitCode: failed > 0 ? 1 : 0 };
}

/**
 * Mark the current branch's PR as ready for review.
 *
 * Validates eligibility (CI green, no conflicts, no unresolved threads,
 * no unchecked checkboxes) before converting from draft to ready.
 *
 * Options:
 *   --pr=N    Target a specific PR number instead of auto-detecting.
 *   --force   Skip eligibility checks and mark as ready anyway.
 */
async function ready(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const force = Boolean(options.force);

  let prNum: number | null = null;
  if (options.pr !== undefined) {
    const rawPr = String(options.pr);
    const parsed = parseInt(rawPr, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return {
        output: `${c.red}Invalid --pr value: ${rawPr}${c.reset}\n`,
        exitCode: 1,
      };
    }
    prNum = parsed;
  }

  if (!prNum) {
    const branch = currentBranch();
    const prs = await githubApi<GitHubPR[]>(
      `/repos/${REPO}/pulls?head=quantified-uncertainty:${branch}&state=open`
    );
    if (!prs.length) {
      return {
        output: `${c.red}No open PR found for branch ${currentBranch()}.${c.reset}\n`,
        exitCode: 1,
      };
    }
    prNum = prs[0].number;
  }

  // Fetch full PR details via GraphQL for eligibility checks
  const { checkMergeEligibility, fetchSinglePr } = await import('../lib/pr-analysis/index.ts');
  const prNode = await fetchSinglePr(prNum);

  if (!prNode) {
    return {
      output: `${c.red}Could not fetch PR #${prNum} details.${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Check eligibility (unless --force)
  if (!force) {
    const eligibility = checkMergeEligibility(prNode);
    // Ignore only is-draft: this command exists to remove that block.
    // CI must still be green — matching PR Patrol auto-undraft behavior.
    const blockReasons = eligibility.blockReasons.filter(
      (r: string) => r !== 'is-draft',
    );

    if (blockReasons.length > 0) {
      let output = `${c.red}✗ PR #${prNum} is not eligible to be marked ready:${c.reset}\n`;
      for (const reason of blockReasons) {
        output += `  - ${reason}\n`;
      }
      output += `\n  Use --force to mark ready anyway.\n`;
      return { output, exitCode: 1 };
    }
  }

  // Convert from draft to ready via GraphQL mutation
  // (GitHub REST API doesn't support undrafting — only GraphQL works)
  try {
    const { githubGraphQL } = await import('../lib/github.ts');
    const prData = await githubApi<{ node_id: string }>(`/repos/${REPO}/pulls/${prNum}`);
    await githubGraphQL(
      `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
      { id: prData.node_id },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      output: `${c.red}Failed to mark PR #${prNum} as ready: ${msg}${c.reset}\n`,
      exitCode: 1,
    };
  }

  let output = `${c.green}✓${c.reset} PR #${prNum} marked as ready for review.\n`;
  if (force) output += `  ${c.yellow}(eligibility checks skipped with --force)${c.reset}\n`;

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// PR check — issue detection and merge eligibility report
// ---------------------------------------------------------------------------

/**
 * Check a single PR or all open PRs for issues and merge eligibility.
 *
 * Usage:
 *   crux pr check 1837           Single PR: issues + merge eligibility report
 *   crux pr check --all          All open PRs: ranked by issue score
 *   crux pr check --all --json   Machine-readable output
 */
async function check(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const json = Boolean(options.json);
  const all = Boolean(options.all);

  const {
    fetchOpenPrs,
    fetchSinglePr,
    detectIssues,
    checkMergeEligibility,
    rankPrs,
    ISSUE_SCORES,
  } = await import('../lib/pr-analysis/index.ts');

  const staleThresholdMs = Date.now() - 48 * 3600 * 1000; // 48h default

  if (all) {
    // All open PRs: ranked by issue score
    const prs = await fetchOpenPrs();

    const results = prs.map((pr) => {
      const { issues, botComments } = detectIssues(pr, staleThresholdMs);
      const eligibility = checkMergeEligibility(pr);
      return {
        number: pr.number,
        title: pr.title,
        branch: pr.headRefName,
        createdAt: pr.createdAt,
        isDraft: pr.isDraft,
        issues,
        botComments,
        botCommentCount: botComments.length,
        eligible: eligibility.eligible,
        blockReasons: eligibility.blockReasons,
      };
    });

    const withIssues = results.filter((r) => r.issues.length > 0);
    const ranked = rankPrs(
      withIssues.map((r) => ({
        number: r.number,
        title: r.title,
        branch: r.branch,
        createdAt: r.createdAt,
        issues: r.issues,
        botComments: r.botComments,
      })),
    );

    if (json) {
      return { output: JSON.stringify({ total: prs.length, withIssues: withIssues.length, prs: results }, null, 2) + '\n', exitCode: withIssues.length > 0 ? 1 : 0 };
    }

    let output = `${c.bold}PR Check — ${prs.length} open PRs${c.reset}\n\n`;

    if (ranked.length === 0) {
      output += `${c.green}All PRs clean — no issues detected.${c.reset}\n`;
    } else {
      output += `${c.bold}PRs with issues${c.reset} (${ranked.length}, ranked by priority):\n`;
      for (const pr of ranked) {
        const r = results.find((x) => x.number === pr.number)!;
        output += `  ${c.cyan}#${pr.number}${c.reset} [score=${pr.score}] ${pr.issues.join(', ')}`;
        if (!r.eligible) output += ` ${c.dim}(merge blocked: ${r.blockReasons.join(', ')})${c.reset}`;
        output += `\n    ${c.dim}${pr.title}${c.reset}\n`;
      }
    }

    const clean = results.filter((r) => r.issues.length === 0);
    if (clean.length > 0) {
      output += `\n${c.green}Clean PRs${c.reset} (${clean.length}):\n`;
      for (const r of clean) {
        const eligIcon = r.eligible ? `${c.green}✓${c.reset}` : `${c.dim}-${c.reset}`;
        output += `  ${eligIcon} ${c.cyan}#${r.number}${c.reset} ${c.dim}${r.title}${c.reset}\n`;
      }
    }

    return { output, exitCode: withIssues.length > 0 ? 1 : 0 };
  }

  // Single PR mode
  const prNum = parseInt(args[0], 10);
  if (!prNum || isNaN(prNum)) {
    return {
      output: `${c.red}Usage: crux pr check <N> or crux pr check --all${c.reset}\n`,
      exitCode: 1,
    };
  }

  const pr = await fetchSinglePr(prNum);
  if (!pr) {
    return {
      output: `${c.red}Could not fetch PR #${prNum}.${c.reset}\n`,
      exitCode: 1,
    };
  }

  const { issues, botComments } = detectIssues(pr, staleThresholdMs);
  const eligibility = checkMergeEligibility(pr);

  if (json) {
    return {
      output: JSON.stringify({
        number: pr.number,
        title: pr.title,
        branch: pr.headRefName,
        isDraft: pr.isDraft,
        issues,
        botComments: botComments.length,
        eligible: eligibility.eligible,
        blockReasons: eligibility.blockReasons,
      }, null, 2) + '\n',
      exitCode: issues.length > 0 ? 1 : 0,
    };
  }

  let output = `${c.bold}PR #${prNum}: ${pr.title}${c.reset}\n`;
  output += `  Branch: ${pr.headRefName}\n`;
  output += `  Draft: ${pr.isDraft ? 'yes' : 'no'}\n`;
  output += `  Mergeable: ${pr.mergeable}\n\n`;

  if (issues.length === 0) {
    output += `${c.green}✓ No issues detected.${c.reset}\n`;
  } else {
    output += `${c.yellow}Issues detected (${issues.length}):${c.reset}\n`;
    for (const issue of issues) {
      const score = ISSUE_SCORES[issue] ?? 0;
      output += `  ${c.yellow}•${c.reset} ${issue} (priority: ${score})\n`;
    }
  }

  if (botComments.length > 0) {
    output += `\n${c.yellow}Bot review comments (${botComments.length}):${c.reset}\n`;
    for (const bc of botComments) {
      output += `  ${c.dim}${bc.author}${c.reset} on ${bc.path}${bc.line ? `:${bc.line}` : ''}\n`;
    }
  }

  output += `\n${c.bold}Merge eligibility:${c.reset} ${eligibility.eligible ? `${c.green}eligible${c.reset}` : `${c.red}blocked${c.reset}`}\n`;
  if (eligibility.blockReasons.length > 0) {
    for (const reason of eligibility.blockReasons) {
      output += `  ${c.red}✗${c.reset} ${reason}\n`;
    }
  }

  return { output, exitCode: issues.length > 0 ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// PR overlaps — detect file-level overlaps across open PRs
// ---------------------------------------------------------------------------

/**
 * Detect file-level overlaps across open PRs.
 *
 * Usage:
 *   crux pr overlaps            Show file overlaps across open PRs
 *   crux pr overlaps --json     Machine-readable
 */
async function overlaps(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const json = Boolean(options.json);

  const { fetchOpenPrs, detectOverlaps } = await import('../lib/pr-analysis/index.ts');

  const prs = await fetchOpenPrs();
  const overlapResults = await detectOverlaps(prs);

  if (json) {
    return {
      output: JSON.stringify({ total_prs: prs.length, overlaps: overlapResults }, null, 2) + '\n',
      exitCode: overlapResults.length > 0 ? 1 : 0,
    };
  }

  if (overlapResults.length === 0) {
    return {
      output: `${c.green}✓ No file overlaps detected across ${prs.length} open PRs.${c.reset}\n`,
      exitCode: 0,
    };
  }

  let output = `${c.bold}File overlaps across ${prs.length} open PRs${c.reset}\n\n`;
  output += `${c.yellow}Found ${overlapResults.length} overlapping PR pair(s):${c.reset}\n\n`;

  for (const overlap of overlapResults) {
    output += `  ${c.cyan}#${overlap.prA}${c.reset} ↔ ${c.cyan}#${overlap.prB}${c.reset}: ${overlap.sharedFiles.length} shared file(s)\n`;
    for (const file of overlap.sharedFiles.slice(0, 10)) {
      output += `    ${c.dim}${file}${c.reset}\n`;
    }
    if (overlap.sharedFiles.length > 10) {
      output += `    ${c.dim}(+${overlap.sharedFiles.length - 10} more)${c.reset}\n`;
    }
    output += '\n';
  }

  return { output, exitCode: 1 };
}

// ---------------------------------------------------------------------------
// Domain entry point (required by crux.mjs dispatch)
// ---------------------------------------------------------------------------

export const commands = {
  create,
  ready,
  detect,
  check,
  overlaps,
  'fix-body': fixBody,
  'rebase-all': rebaseAll,
  'validate-test-plan': validateTestPlanCmd,
  'resolve-conflicts': resolveConflictsCmd,
};

export function getHelp(): string {
  return `
PR Domain — GitHub Pull Request utilities

Commands:
  create                        Create a draft PR for the current branch (corruption-safe).
  ready [--pr=N]                Mark PR as ready (validates eligibility, removes draft status).
  detect                        Detect open PR for current branch (returns URL + number).
  check <N>                     Check a single PR for issues and merge eligibility.
  check --all                   Check all open PRs, ranked by issue priority score.
  overlaps                      Detect file-level overlaps across open PRs.
  fix-body [--pr=N]             Detect and repair literal \\n in the current branch's PR body.
  rebase-all                    Rebase all open non-draft PRs onto main (used by CI).
  validate-test-plan [--pr=N]   Check that the PR's test plan section is complete.
  resolve-conflicts             Find and resolve all open PRs with merge conflicts.

Options (create):
  --title="..."       Required. PR title.
  --body="..."        PR body (inline — avoid for multi-line bodies; use --body-file or stdin).
  --body-file=<path>  PR body from file (safe for markdown with backticks).
  --base=main         Base branch (default: main).
  --no-draft          Create as ready PR (default: draft).
  --allow-empty-body  Allow creating PR without a description (not recommended).
  --skip-test-plan    Skip test plan validation (not recommended).
  (stdin)             If --body and --body-file are absent and stdin is a pipe, body is read from stdin.

Options (ready):
  --pr=N              Target a specific PR number instead of auto-detecting.
  --force             Skip eligibility checks and mark as ready anyway.

Options (detect):
  --ci                JSON output.

Options (fix-body / validate-test-plan):
  --pr=N              Target a specific PR number instead of auto-detecting.
  --json              JSON output (validate-test-plan only).

Options (rebase-all):
  --verbose           Show detailed progress for each PR.

Options (resolve-conflicts):
  --verbose           Show detailed output.

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
  pnpm crux pr rebase-all                 # Rebase all open PRs onto main
  pnpm crux pr rebase-all --verbose       # With detailed output
  pnpm crux pr check 1837                # Check single PR for issues
  pnpm crux pr check --all               # Check all open PRs, ranked
  pnpm crux pr check --all --json        # Machine-readable output
  pnpm crux pr overlaps                  # Detect file overlaps across PRs
  pnpm crux pr overlaps --json           # Machine-readable output
  pnpm crux pr resolve-conflicts         # Resolve all conflicted PRs
  pnpm crux pr resolve-conflicts --verbose  # With detailed output
`.trim();
}
