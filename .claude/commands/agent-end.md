---
description: End the current session — log it, update issues, clean up, reset slot back to main. No shipping required.
effort: low
---

# Agent End

Close out a session that does not need `/agent-ship` (research, abandoned work,
maintenance, or a quick fix already pushed by hand).

**Read `docs/agent-workflows/agent-end.md` and execute every step in order.**
That file is the single source of truth and is shared across agent runtimes.

Claude-specific final step: after the workflow finishes, tell the user to run
`/clear` (wipe context) and `/rename` (clear the Claude Code session name).
Both are Claude Code built-ins and cannot be invoked from this command file.
