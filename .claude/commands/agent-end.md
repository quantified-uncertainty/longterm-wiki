---
description: End the current session — log it, update issues, clean up, reset slot back to main. No shipping required.
effort: low
---

# Agent End

Close out a session that does not need `/agent-ship` (research, abandoned work,
maintenance, or a quick fix already pushed by hand).

The fastest path is to run the consolidated TS command, which executes every
step in `docs/agent-workflows/agent-end.md` in one process:

```bash
pnpm crux sys agent-end                 # default
pnpm crux sys agent-end --pr=<URL>      # if you created a PR
pnpm crux sys agent-end --dry-run       # print actions, take none
```

If that bails (exit 2) on unexpected dirty state — uncommitted edits to a
non-`.claude/` path or unpushed commits on the feature branch — read what it
lists, decide whether to commit/push/discard, then re-run. Last-resort:
`--dirty=force` discards everything.

For runtimes without `pnpm`, or to debug a step in isolation, follow
`docs/agent-workflows/agent-end.md` step by step — it is the cross-runtime
source of truth and stays in sync with the TS command.

Claude-specific final step: after the close-out finishes, tell the user to run
`/clear` (wipe context) and `/rename` (clear the Claude Code session name).
Both are Claude Code built-ins and cannot be invoked from this command file.
