/**
 * Standard review/ship instructions to append to subagent dispatch prompts.
 *
 * Coordinators dispatching subagents should include the output of
 * `reviewAndShipInstructions()` at the end of their dispatch prompt so the
 * subagent runs `/agent-review-pr` and `/agent-ship` instead of creating PRs
 * directly via `pnpm crux gh pr create`.
 *
 * Background: see `docs/agent-rules/dispatched-agent-review.md`. A session on
 * 2026-04-11 dispatched 15 PRs where subagents bypassed the ship flow. ~53%
 * had real bugs that only adversarial review caught.
 */

/**
 * Standard instructions to run /agent-review-pr and /agent-ship at the end of
 * a subagent's work. Append this to the dispatch prompt after the task-specific
 * body.
 */
export function reviewAndShipInstructions(): string {
  return `
### Before creating the PR

Run \`/agent-review-pr\` on your changes — it's adaptive and scales to PR size. Address every finding before proceeding. Do NOT skip this step. Do NOT use \`pnpm crux gh pr create\` directly.

### Creating the PR

Use \`/agent-ship\` — it runs the full workflow including the mandatory review step, deploy task detection, Linear updates, and session logging. Do NOT bypass it.

### Reporting back

When you report completion, include:
1. The PR URL (confirm via \`gh pr view <N>\`)
2. Output of \`git show --stat HEAD\` so the coordinator can verify your commit actually contains the claimed changes
3. A summary of review findings (if any) and what you did about them
`.trimStart();
}

/**
 * A shorter variant for quick dispatches where the full instructions would be
 * overkill (e.g. trivial typo fixes). Still points to /agent-ship.
 */
export function shortShipInstructions(): string {
  return `
### Shipping

When done, use \`/agent-ship\` (not raw \`gh pr create\`). It handles review, deploy tasks, and Linear updates.
`.trimStart();
}
