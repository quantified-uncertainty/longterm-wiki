---
description: End the current session — log it, update issues, clean up, reset slot back to main. No shipping required.
effort: low
---

# Agent End

Close out a session that does not need `/agent-ship`.

Follow the canonical workflow in
[`docs/agent-workflows/agent-end.md`](../../docs/agent-workflows/agent-end.md).

Claude-specific final step: after the workflow finishes, tell the user to run
`/clear` and `/rename`. Those are Claude Code built-ins and cannot be invoked
from this command file.
