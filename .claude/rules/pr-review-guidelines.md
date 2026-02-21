# PR Review & Ship Workflow — MANDATORY

Before considering any session complete, you MUST execute the review-and-ship workflow. Do not skip steps. Do not ask the user whether to do this — it is always required.

## GitHub issue auto-close syntax

When a PR closes GitHub issues, use **one `Closes #N` per line** in the PR body. A comma-separated list (`Closes #1, #2, #3`) is **not** reliably recognized by GitHub and will only close the first issue.

```
Closes #529
Closes #530
Closes #533
Closes #538
```

## Preferred: `/agent-session-ready-PR`

The recommended end-of-session command is `/agent-session-ready-PR`. It verifies the agent checklist (from `/agent-session-start`), polishes the PR description, updates GitHub issues, creates a session log, and calls `/push-and-ensure-green` to ship.

If `/agent-session-start` was run at session start and `.claude/wip-checklist.md` exists, just run `/agent-session-ready-PR` — it handles everything.

## Fallback: Quick fix sessions

If `/agent-session-start` was not run (e.g., a quick fix session), run `/agent-session-ready-PR` directly — it will generate a checklist on the fly if one doesn't exist, then walk through completion and shipping.

As a bare minimum, always run `/push-and-ensure-green` before considering work complete.
