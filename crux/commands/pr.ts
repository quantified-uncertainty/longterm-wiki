/**
 * PR Command Handlers
 *
 * Utilities for managing GitHub Pull Requests associated with the current branch.
 *
 * Usage:
 *   crux gh pr create             Create a PR for the current branch (corruption-safe)
 *   crux gh pr detect             Detect open PR for current branch (returns PR URL + number)
 *   crux gh pr fix-body           Detect and repair literal \n in the current branch's PR body
 *   crux gh pr fix-body --pr=N    Target a specific PR number instead of auto-detecting
 *   crux gh pr rebase-all         Rebase all open non-draft PRs onto main (CI usage)
 *   crux gh pr resolve-conflicts  Find and resolve all conflicted PRs
 */

import { readFileSync } from 'fs';
import { createLogger } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';
import { currentBranch } from '../lib/session/session-checklist.ts';
import { rebaseAllPrs } from '../lib/pr-rebase.ts';
import { resolveAllConflicts } from '../lib/conflict-resolution.ts';
import { parseDeployTasksFromBody } from '../lib/deploy-tasks/detect.ts';
import { parseLinearId } from '../lib/linear/parse-id.ts';
import {
  findOpenPrsMentioningLinearId,
  type OpenPrMatch,
} from '../lib/linear/dedup.ts';
import { checkReviewMarker } from '../lib/review-marker.ts';
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

/**
 * Collect Linear IDs from branch name, explicit flag, and (as a last-resort
 * fallback) checklist metadata, then inject `Fixes QUA-NNN` lines into the
 * PR body for any not already referenced. Linear's GitHub integration
 * auto-moves issues to Done on PR merge when it sees these.
 *
 * Source precedence (QUA-457):
 *   1. Branch name (e.g. `claude/qua-184-...`) — the canonical source.
 *   2. Explicit `--linear` flag(s) — added on top.
 *   3. `.claude/wip-checklist.md` `> Linear: QUA-NNN` — used ONLY when the
 *      branch name itself encodes no Linear ID. When the branch does encode
 *      an ID, the checklist is ignored. This prevents a stale checklist from
 *      a prior session leaking the wrong Linear ID into the current ticket's
 *      PR body (see PR #4306 incident).
 *
 * Emits a mismatch warning (returned as `warnings`) when the explicit
 * `--linear` disagrees with the branch-encoded ID — the caller can print
 * this so operators notice the inconsistency before shipping.
 */
export function injectLinearRefs(
  body: string,
  branch: string,
  explicitLinear: string | undefined,
  checklistLinearId: string | null,
): { body: string; injected: string[]; warnings: string[] } {
  const linearIds: string[] = [];
  const warnings: string[] = [];

  const branchLinearId = parseLinearId(branch);
  if (branchLinearId) linearIds.push(branchLinearId);

  if (explicitLinear) {
    for (const token of explicitLinear.split(',')) {
      const parsed = parseLinearId(token.trim());
      if (!parsed) continue;
      if (branchLinearId && parsed !== branchLinearId && !linearIds.includes(parsed)) {
        warnings.push(
          `--linear=${parsed} disagrees with branch "${branch}" (${branchLinearId}); injecting both`,
        );
      }
      if (!linearIds.includes(parsed)) linearIds.push(parsed);
    }
  }

  // Checklist is a last-resort fallback ONLY when the branch doesn't carry a
  // Linear ID. Otherwise, a stale checklist from a prior session can leak a
  // wrong ID into the PR body (QUA-457).
  if (!branchLinearId && checklistLinearId && !linearIds.includes(checklistLinearId)) {
    linearIds.push(checklistLinearId);
  } else if (
    branchLinearId &&
    checklistLinearId &&
    checklistLinearId !== branchLinearId &&
    !linearIds.includes(checklistLinearId) // don't warn if --linear already injected this ID
  ) {
    warnings.push(
      `checklist Linear ID ${checklistLinearId} ignored (branch-encoded ${branchLinearId} takes precedence)`,
    );
  }

  const alreadyReferenced = new Set(
    [...body.matchAll(/(?:Fixes|Closes|Resolves)\s+(QUA-\d+)/gi)].map(m => m[1].toUpperCase())
  );
  const toInject = linearIds.filter(id => !alreadyReferenced.has(id));

  if (toInject.length === 0) return { body, injected: [], warnings };

  const refs = toInject.map(id => `Fixes ${id}`).join('\n');
  return {
    body: body.trimEnd() + '\n\n' + refs + '\n',
    injected: toInject,
    warnings,
  };
}

/**
 * Extract the set of Linear IDs that will auto-close on PR merge, based on
 * the `Fixes|Closes|Resolves QUA-NNN` markers GitHub/Linear parse. Used by
 * the pre-PR dedup check to ask "which tickets is this PR about to claim?"
 *
 * Deliberately narrower than "any QUA-NNN mention" — we only block on
 * auto-close collisions. Incidental mentions in the PR description (e.g.
 * "related to QUA-500") are not a dedup signal.
 */
export function extractLinearAutoCloseRefs(body: string): string[] {
  const ids = new Set<string>();
  for (const m of body.matchAll(/(?:Fixes|Closes|Resolves)\s+(QUA-\d+)/gi)) {
    ids.add(m[1].toUpperCase());
  }
  return [...ids];
}

export interface LinearPrCollision {
  linearId: string;
  prs: OpenPrMatch[];
}

/**
 * For each Linear ID the PR is about to claim, find open PRs already
 * referencing it. Any hit is a collision (QUA-304 Layer 3) — two sessions
 * racing to ship the same ticket produces duplicate work.
 *
 * The `lookupPrs` dependency is injectable so callers can unit-test the
 * decision logic without hitting the GitHub API. In production it defaults
 * to `findOpenPrsMentioningLinearId`, which fails open on API errors.
 *
 * Lookups run in parallel — for an epic PR claiming several IDs, sequential
 * awaits would add a network round-trip per ID. The GitHub Search API's
 * 30/min rate limit comfortably absorbs the few-at-a-time burst.
 */
export async function checkLinearPrCollisions(
  linearIds: string[],
  lookupPrs: (id: string) => Promise<OpenPrMatch[]> = findOpenPrsMentioningLinearId,
): Promise<LinearPrCollision[]> {
  const results = await Promise.all(
    linearIds.map(async (id) => ({ linearId: id, prs: await lookupPrs(id) })),
  );
  return results.filter((r) => r.prs.length > 0);
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
 *   --title="PR title"          Required. Title for the PR.
 *   --body="PR body"            Body as inline string (vulnerable to shell expansion).
 *   --body-file=<path>          Body from a file (safe for markdown with backticks).
 *   --base=main                 Base branch (default: main).
 *   --draft                     Create as draft PR.
 *   --skip-review-check         Bypass the /agent-review-pr marker check.
 *      --reason="<why>"           REQUIRED with --skip-review-check.
 *   --force                     Bypass Linear-ID dedup check (existing).
 *   --allow-empty-body          Allow PR body to be empty (existing, discouraged).
 *   --skip-test-plan            Bypass test-plan validation (existing).
 *   (default: ready — agents verify before creating PRs)
 *
 * Pre-checks (in order, all refuse with exit 2 unless bypassed):
 *   1. Body not empty                                (--allow-empty-body)
 *   2. Test plan section present                     (--skip-test-plan)
 *   3. /agent-review-pr marker fresh against HEAD    (--skip-review-check, QUA-849 #7)
 *   4. No open PR already claims a referenced Linear (--force)
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
  // Default to ready (non-draft). Agents run build/test/gate before PR creation,
  // so the PR is already verified. Draft PRs block PR patrol and Linear automation.
  const draft = options.draft === true ? true : false;

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
          `    stdin heredoc:  pnpm crux gh pr create --title="..." <<'PRBODY'\\n## Summary\\nPRBODY\n` +
          `  Or pass --allow-empty-body to force creation without a description.\n`,
        exitCode: 1,
      };
    }
  }

  if (!title) {
    return {
      output: `${c.red}Usage: crux gh pr create --title="PR title" --body="PR body" [--body-file=<path>] [--base=main] [--draft]${c.reset}\n`,
      exitCode: 1,
    };
  }

  // ── Review-marker check (QUA-849 #7) ────────────────────────────────────
  // Refuse PR creation unless `.claude/review-done` exists and is fresh
  // against HEAD's commit + diff hash. This catches the failure mode where
  // an agent goes straight from `git push` to `crux gh pr create` without
  // running `/agent-review-pr` (the upstream cousin of QUA-849's
  // "ran skill, lied about phases" — see the QUA-728 incident PR #4689).
  //
  // Bypass: --skip-review-check with a required --reason. We require the
  // reason because the rule's purpose is to make "I considered it" not a
  // possible path; an empty bypass would defeat the gate.
  const skipReviewCheck = Boolean(
    options.skipReviewCheck ?? options['skip-review-check'],
  );
  const reviewReason = (options.reason as string | undefined) ?? '';
  if (skipReviewCheck) {
    if (!reviewReason.trim()) {
      return {
        output:
          `${c.red}--skip-review-check requires --reason="<why>".${c.reset}\n` +
          `  The reason gets logged to PR creation telemetry so a forced\n` +
          `  bypass stays traceable. Empty bypasses defeat the gate.\n`,
        exitCode: 1,
      };
    }
    log.warn(`⚠ Skipping /agent-review-pr marker check (--reason: ${reviewReason})`);
  } else {
    const marker = checkReviewMarker();
    if (!marker.ok) {
      return {
        output:
          `${c.red}✗ Review marker check failed (code: ${marker.code}).${c.reset}\n` +
          `  ${marker.message}\n\n` +
          `  ${c.yellow}Why this exists:${c.reset} skipping /agent-review-pr has shipped\n` +
          `  HIGH-severity correctness bugs that the agent's own tests didn't catch\n` +
          `  (see QUA-728 incident PR #4689). The hostile-reviewer subagent in\n` +
          `  /agent-review-pr reads the diff with no context and catches things\n` +
          `  CodeRabbit and automated checks miss.\n\n` +
          `  ${c.bold}To fix:${c.reset} run ${c.cyan}/agent-review-pr${c.reset} now, address its findings,\n` +
          `  then re-run this command.\n\n` +
          `  ${c.dim}Genuine emergencies only: re-run with --skip-review-check\n` +
          `  --reason="<why>" to bypass.${c.reset}\n`,
        exitCode: 2,
      };
    }
    log.info(marker.message);
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

      // Check 3: Pending deploy tasks from recently merged PRs (warning only)
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 14);
      for (const pr of recentMerged) {
        if (!pr.merged_at || !pr.body) continue;
        if (new Date(pr.merged_at) < cutoff) continue;
        const parsed = parseDeployTasksFromBody(pr.body);
        if (parsed && parsed.unchecked > 0) {
          const uncheckedItems = parsed.items.filter(i => !i.checked).map(i => i.text);
          log.warn(
            `PR #${pr.number} ("${pr.title}") has ${parsed.unchecked} unchecked deploy task(s):\n` +
            uncheckedItems.map(t => `    ☐ ${t}`).join('\n') + '\n' +
            `  Run \`pnpm crux gh deploy-tasks pending\` to see all pending tasks.`
          );
        }
      }
    } catch {
      // Quality checks are best-effort — don't block PR creation if they fail
    }

    // Check 4: Test plan validation
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

  // ── Auto-inject Linear issue reference ──────────────────────────────────
  if (body) {
    let checklistLinearId: string | null = null;
    try {
      const checklist = readFileSync('.claude/wip-checklist.md', 'utf-8');
      const match = checklist.match(/^> Linear: ([A-Z]+-\d+)/m);
      if (match) checklistLinearId = match[1];
    } catch {
      // No checklist — skip
    }

    const result = injectLinearRefs(body, branch, options.linear as string | undefined, checklistLinearId);
    for (const w of result.warnings) {
      log.warn(w);
    }
    if (result.injected.length > 0) {
      body = result.body;
      log.info(`Auto-injected Linear reference(s): ${result.injected.join(', ')}`);
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
        `  ${c.dim}Use \`crux gh pr fix-body\` to update the body if needed.${c.reset}\n`,
      exitCode: 0,
    };
  }

  // ── Pre-PR Linear dedup (QUA-304 Layer 3) ───────────────────────────────
  // If this PR is about to claim a Linear ticket that another *open* PR
  // already claims, refuse — two agents shipping duplicate PRs for the
  // same QUA-NNN is the exact incident shape that motivated this check.
  // Fail-open: `findOpenPrsMentioningLinearId` swallows API errors into an
  // empty list, so a GitHub glitch never blocks PR creation.
  if (body && !(options.force ?? options['allow-duplicate-linear'])) {
    const claimedIds = extractLinearAutoCloseRefs(body);
    if (claimedIds.length > 0) {
      const collisions = await checkLinearPrCollisions(claimedIds);
      if (collisions.length > 0) {
        let msg = `${c.red}✗ Linear dedup collision — another open PR already claims this ticket.${c.reset}\n\n`;
        for (const col of collisions) {
          const label = col.prs.length === 1 ? 'Open PR' : `${col.prs.length} open PRs`;
          msg += `  ${c.bold}${col.linearId}${c.reset} — ${label}:\n`;
          for (const pr of col.prs) {
            msg += `    ${c.cyan}#${pr.number}${c.reset} ${pr.title}\n`;
            msg += `    ${c.dim}${pr.url}${c.reset}\n`;
          }
        }
        msg +=
          `\n  ${c.yellow}Investigate the existing PR(s) before opening a duplicate.${c.reset}\n` +
          `  If the other PR is abandoned or you have explicit authorization,\n` +
          `  re-run with ${c.bold}--force${c.reset} to bypass this check.\n`;
        return { output: msg, exitCode: 2 };
      }
    }
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
    output += `${c.yellow}${failed} PR(s) failed to push — they may need manual attention or will be retried on next run.${c.reset}\n`;
  }

  // Push failures and conflicts are expected/self-healing states, not errors.
  // Only exit non-zero if there are actual unexpected errors (currently none tracked).
  return { output, exitCode: 0 };
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
 *   crux gh pr check 1837           Single PR: issues + merge eligibility report
 *   crux gh pr check --all          All open PRs: ranked by issue score
 *   crux gh pr check --all --json   Machine-readable output
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
        labels: pr.labels.nodes.map((l) => l.name),
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
        labels: r.labels,
      })),
    );

    const hasProblems = results.some((r) => r.issues.length > 0 || !r.eligible);
    if (json) {
      return { output: JSON.stringify({ total: prs.length, withIssues: withIssues.length, prs: results }, null, 2) + '\n', exitCode: hasProblems ? 1 : 0 };
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

    return { output, exitCode: hasProblems ? 1 : 0 };
  }

  // Single PR mode
  const prNum = parseInt(args[0], 10);
  if (!prNum || isNaN(prNum)) {
    return {
      output: `${c.red}Usage: crux gh pr check <N> or crux gh pr check --all${c.reset}\n`,
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
      exitCode: issues.length > 0 || !eligibility.eligible ? 1 : 0,
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

  return { output, exitCode: issues.length > 0 || !eligibility.eligible ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// PR overlaps — detect file-level overlaps across open PRs
// ---------------------------------------------------------------------------

/**
 * Detect file-level overlaps across open PRs.
 *
 * Usage:
 *   crux gh pr overlaps            Show file overlaps across open PRs
 *   crux gh pr overlaps --json     Machine-readable
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
  create                        Create a PR for the current branch (corruption-safe).
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
  --draft             Create as draft PR (default: ready).
  --allow-empty-body  Allow creating PR without a description (not recommended).
  --skip-test-plan    Skip test plan validation (not recommended).
  --linear=QUA-NNN    Inject Linear issue references (comma-separated for epics: QUA-155,QUA-151).
                      Auto-detected from branch name and .claude/wip-checklist.md if omitted.
  --force             Bypass the Linear dedup check (QUA-304). Use when the existing open PR is
                      abandoned or you have explicit authorization to take over the claim.
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
  pnpm crux gh pr create --title="Add feature X" <<'EOF'
  ## Summary
  - Added X

  ## Test plan
  - [x] Ran unit tests
  EOF

  # Multi-line body via file (also recommended):
  pnpm crux gh pr create --title="Add feature X" --body-file=/tmp/pr-body.md

  # Short single-line body inline:
  pnpm crux gh pr create --title="Fix typo" --body="Fix typo in docs"

  pnpm crux gh pr detect                    # Check if PR exists for this branch
  pnpm crux gh pr detect --ci               # JSON output for scripts
  pnpm crux gh pr fix-body                  # Fix PR for current branch
  pnpm crux gh pr fix-body --pr=42          # Fix a specific PR
  pnpm crux gh pr validate-test-plan        # Check test plan on current PR
  pnpm crux gh pr validate-test-plan --pr=42 --json  # Check specific PR (JSON)
  pnpm crux gh pr rebase-all                 # Rebase all open PRs onto main
  pnpm crux gh pr rebase-all --verbose       # With detailed output
  pnpm crux gh pr check 1837                # Check single PR for issues
  pnpm crux gh pr check --all               # Check all open PRs, ranked
  pnpm crux gh pr check --all --json        # Machine-readable output
  pnpm crux gh pr overlaps                  # Detect file overlaps across PRs
  pnpm crux gh pr overlaps --json           # Machine-readable output
  pnpm crux gh pr resolve-conflicts         # Resolve all conflicted PRs
  pnpm crux gh pr resolve-conflicts --verbose  # With detailed output
`.trim();
}
