# Agent Session Workflow — MANDATORY

Every session that involves writing or changing code MUST follow this two-step workflow.

## At Session Start — BEFORE taking any action

Run `/agent-session-start` as the very first thing — before reading files, running commands, or writing any code. "Before writing code" is not sufficient; quick fixes and file reads count too. If you start without this, you will forget it entirely.

```bash
# If working on a GitHub issue:
pnpm crux agent-checklist init --issue=N
pnpm crux issues start <N>

# If not on an issue:
pnpm crux agent-checklist init "Task description" --type=X
```

Valid types: `content`, `infrastructure`, `bugfix`, `refactor`, `commands`. Default: `infrastructure`.

Then read `.claude/wip-checklist.md` and keep it updated as you work.

## At Session End — BEFORE considering work complete

Run `/agent-session-ready-PR`. It verifies the checklist, polishes the PR, and ships.

See `.claude/rules/pr-review-guidelines.md` for the full end-of-session workflow.

## Why this matters

- The checklist catches issues that are easy to skip under time pressure (security review, no regressions, CI green)
- It creates a paper trail of decisions for future sessions
- Skipping it is how things like "forgot to verify CI" or "no tests written" happen
- Rationalizing "I'll do it after I read a couple files" reliably leads to skipping it — the rule must be unconditional
