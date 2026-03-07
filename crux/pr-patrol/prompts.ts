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
- **STOP IMMEDIATELY and report** if ANY of these apply:
  - The check requires a human action (adding a label like \`gate:rules-ok\`, manual approval, etc.)
  - The failure is in a Vercel deployment or external service (not a code issue)
  - The same check is also failing on the \`main\` branch (pre-existing, not caused by this PR)
  - The failure is a permissions or authentication issue
- If the failure IS a code issue you can fix: fix it, run locally to verify (pnpm build / pnpm test), commit and push`);
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
## Guardrails
- Only fix the detected issues — do not refactor or improve unrelated code
- If a conflict is too complex to resolve confidently, skip it and note why
- After any code changes, run: pnpm crux validate gate --fix
- Use git push --force-with-lease (never --force) when pushing rebased branches
- Do not modify files unrelated to the fix
- Do NOT run /agent-session-start or /agent-session-ready-PR — this is a targeted fix, not a full session
- Do NOT create new branches — work on the existing PR branch

## When to stop early
- **If the issue requires human intervention** (adding labels, approvals, external service fixes): output a clear summary of why and stop immediately. Do not attempt workarounds.
- **If the issue is pre-existing** (also failing on main, not introduced by this PR): state that and stop.
- **If you've tried 2+ approaches and none worked**: stop and summarize what you tried. Do not keep cycling through the same strategies.
- **If the fix is "no action needed"** (e.g., no matching issue exists for missing-issue-ref): say so and stop. Not every detected issue requires a code change.
- Stopping early with a clear explanation is BETTER than burning through all turns without progress.`);

  return sections.join('\n');
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
