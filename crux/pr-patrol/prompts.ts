/**
 * PR Patrol — Prompt builders for Claude fix sessions
 */

import type { DetectedPr } from './types.ts';

// ── Shell safety ────────────────────────────────────────────────────────────

/** Shell-quote a value to prevent injection via attacker-controlled inputs (e.g., branch names). */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// ── PR fix prompt ────────────────────────────────────────────────────────────

export function buildPrompt(pr: DetectedPr, repo: string): string {
  const { number: num, title, branch, issues } = pr;
  const sections: string[] = [];

  sections.push(`You are a PR maintenance agent for the ${repo} repository.

## Target
PR #${num}: "${title}" (branch: ${branch})

## Issues Detected
${issues.join(', ')}

## Instructions

1. First, fetch PR details to understand context:
   gh pr view ${num} --repo ${repo} --json headRefName,body,statusCheckRollup,reviews

2. Check out the PR branch:
   git fetch origin ${shQuote(branch)}
   git checkout ${shQuote(branch)}

3. Fix each detected issue:`);

  if (issues.includes('conflict')) {
    sections.push(`
### Merge Conflict
- Rebase onto main: git rebase origin/main
- Resolve any conflicts (prefer keeping PR changes where intent is clear)
- If conflicts are in generated files (database.json, lock files), regenerate them
- After resolving: git rebase --continue, then git push --force-with-lease`);
  }

  if (issues.includes('ci-failure')) {
    sections.push(`
### CI Failure
- Check CI status: gh pr checks ${num} --repo ${repo}
- Read the failing check logs to understand the failure
- For each failing check, determine the cause:

  **If the check requires a label like \`gate:rules-ok\`:**
  - Read what the check enforces (usually in the CI log or check name)
  - Verify whether the condition is actually satisfied for this PR
  - If yes: add the label yourself — \`gh pr edit ${num} --repo ${repo} --add-label gate:rules-ok\`
  - If no: fix the underlying issue so the condition is satisfied, then add the label

  **If the check is a pre-existing failure on main** (also failing on main, not caused by this PR):
  - Confirm by checking main: gh run list --repo ${repo} --branch main --limit 3
  - If confirmed pre-existing: state that and stop (this is a dead end, not fixable here)

  **If the failure is in a Vercel deployment or external service:**
  - Re-triggering CI often resolves transient Vercel failures: gh pr comment ${num} --repo ${repo} --body "/retry"
  - If it's a persistent Vercel issue, stop and report

  **If the failure is a code issue you can fix:**
  - Fix it, run locally to verify (pnpm build / pnpm test), commit and push`);
  }

  if (issues.includes('missing-testplan')) {
    sections.push(`
### Missing Test Plan
- Read the PR diff to understand what changed
- Update the PR body to add a "## Test plan" section with relevant verification steps
- Use gh pr edit to update the body`);
  }

  if (issues.includes('missing-issue-ref')) {
    sections.push(`
### Missing Issue Reference
- Search for related issues: gh issue list --search "keywords from PR title" --repo ${repo}
- If a matching issue exists, add "Closes #N" to the PR body
- If no matching issue exists, this may be fine — skip this fix`);
  }

  if (issues.includes('stale')) {
    sections.push(`
### Stale PR
- Rebase onto main to pick up latest changes: git fetch origin main && git rebase origin/main
- Push to re-trigger CI: git push --force-with-lease
- If the rebase has conflicts, resolve them`);
  }

  if (issues.includes('bot-review-major') || issues.includes('bot-review-nitpick')) {
    const isActionable = issues.includes('bot-review-major');
    sections.push(`
### Bot Review Comments${isActionable ? ' (Actionable)' : ' (Nitpick only)'}
- Automated code review bots (e.g., CodeRabbit) left unresolved comments on this PR
- Comments marked with 🔴 Critical, 🟠 Major, or 🟡 Minor should be addressed if the concern is valid
- Comments marked 🧹 Nitpick are optional — fix only if trivial and clearly correct
- Look for "Prompt for AI Agents" sections in the comments — these contain ready-made fix instructions
- VERIFY each suggestion against the current code before applying — bots can be wrong
- After addressing comments, commit and push the fixes`);

    if (pr.botComments.length > 0) {
      sections.push('\n#### Bot Comment Details\n');
      for (const c of pr.botComments) {
        const lineRange = c.startLine && c.startLine !== c.line
          ? `lines ${c.startLine}-${c.line}`
          : `line ${c.line}`;
        const body = c.body.length > 2000 ? c.body.slice(0, 2000) + '\n...(truncated)' : c.body;
        sections.push(`**${c.path}** (${lineRange}) — ${c.author}:\n${body}\n`);
      }
    }
  }

  sections.push(`
## Pushing changes

After making and committing fixes, push with:
  git push --force-with-lease

The pre-push gate hook runs automatically. If it fails with a **review marker error**
("Review marker SHA ... does not match HEAD" or "has not been reviewed via /review-pr"),
write the marker directly — patrol fixes are small and targeted, so a full /review-pr
re-review is not required:
  echo "reviewed $(git rev-parse HEAD) $(date -u +%Y-%m-%dT%H:%M:%SZ)" > .claude/review-done
  git add .claude/review-done && git commit -m "chore: update review marker"
  git push --force-with-lease

## Guardrails
- Only fix the detected issues — do not refactor or improve unrelated code
- If a conflict is too complex to resolve confidently, skip it and note why
- After any code changes, run: pnpm crux validate gate --fix
- Use git push --force-with-lease (never --force) when pushing rebased branches
- Do not modify files unrelated to the fix
- Do NOT run /agent-session-start or /agent-session-ready-PR — this is a targeted fix, not a full session
- Do NOT create new branches — work on the existing PR branch

## Escalation order — exhaust automation before stopping

Work through issues in this order. Only escalate to "needs human" after attempting all earlier steps:

1. **Fix the code** — address CI failures, conflicts, and bot review comments directly
2. **Add labels you can verify** — if \`gate:rules-ok\` is needed, verify the rule is actually satisfied,
   then add the label yourself: \`gh pr edit ${num} --add-label gate:rules-ok\`
3. **Address ALL bot comments** — don't skip CodeRabbit/bot comments; try to fix them even if they look complex
4. **Complete checklist items** — update PR body unchecked items when you've verified the task is done
5. **Only then escalate** — if after all the above there's still something only a human can do
   (e.g., approve a security exception, provide missing context the bot flagged as ambiguous),
   output a clear summary and stop

## When to stop (escalate to human)

ONLY stop early for issues that **genuinely require human decision-making**:
- A named individual's approval is required (e.g., security team sign-off)
- External service configuration that only an admin can change
- The PR has intentional breaking changes that need owner confirmation
- Merge conflicts where the intent of both sides is truly ambiguous

**Do NOT stop early for:**
- Labels you can add yourself after verifying the condition is met
- Bot review comments you haven't attempted to fix yet
- CI failures you haven't investigated
- Anything where you could plausibly make progress with more investigation

If the issue is pre-existing (same failure on main branch, not caused by this PR):
state that clearly and stop — this is not a human escalation, just a dead end.

If you've tried 2+ distinct approaches and none worked: stop and summarize what you tried.
Do not keep cycling through the same strategies.`);

  return sections.join('\n');
}

// ── Branch agent prompt ──────────────────────────────────────────────────────

/**
 * Build the prompt for a branch-agent fix session.
 * Similar to buildPrompt but:
 * - Includes cycle context (session N of M)
 * - Emphasizes CI-wait-then-retry workflow
 * - Tells the agent it has multiple sessions available (don't try to do everything at once)
 */
export function buildBranchAgentPrompt(
  pr: DetectedPr,
  repo: string,
  cycle: number,
  maxCycles: number,
): string {
  const basePrompt = buildPrompt(pr, repo);

  const cycleContext = `
## Branch Agent Context

You are session ${cycle} of up to ${maxCycles} for this PR.
- After you finish, CI will run and results will be checked
- If CI still fails after your session, another session will be spawned
- You do NOT need to fix everything in one session — focus on making clear progress
- Stop when you've done one logical unit of work (e.g., fixed the CI failure, or addressed bot comments)
- The outer loop handles retrying and waiting for CI — don't spin endlessly yourself
`;

  return cycleContext + '\n' + basePrompt;
}

// ── Main branch fix prompt ───────────────────────────────────────────────────

export function buildMainBranchPrompt(runId: number, repo: string): string {
  return `You are a CI repair agent for the ${repo} repository.

## Situation

The CI workflow on the \`main\` branch is failing. Run ID: ${runId}

## Instructions

1. First, examine the CI failure logs:
   gh run view ${runId} --repo ${repo} --log-failed 2>/dev/null || gh run view ${runId} --repo ${repo} --log

2. Diagnose the root cause:
   - Is it a flaky test? (Check if re-running would fix it)
   - Is it a real build/test failure introduced by a recent commit?
   - Is it an infrastructure issue (network, package registry, etc.)?

3. If the failure looks flaky or transient:
   - Re-run the workflow: gh run rerun ${runId} --repo ${repo} --failed
   - That's it — no code changes needed

4. If it's a real failure that needs a code fix:
   - Create a fix branch: git checkout -b claude/fix-main-ci-$(date +%s) origin/main
   - Read the relevant source files and fix the issue
   - Run locally to verify: pnpm crux validate gate
   - Commit and push the fix branch
   - Open a PR: gh pr create --repo ${repo} --title "Fix main branch CI failure" --body "Fixes CI failure from run #${runId}"

## Guardrails
- Only fix the CI failure — do not refactor or improve unrelated code
- If the failure is in test expectations that need updating (not a real bug), update the tests
- If you cannot diagnose or fix the issue, output a clear summary of what you found
- Do NOT run /agent-session-start or /agent-session-ready-PR
- Run pnpm crux validate gate --fix before committing`;
}
