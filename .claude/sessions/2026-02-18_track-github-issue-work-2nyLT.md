## 2026-02-18 | track-github-issue-work-2nyLT | Add GitHub issue tracking for Claude Code sessions

**What was done:** Added a `crux issues` CLI domain and supporting rules/commands to track when Claude Code starts and finishes work on GitHub issues. Sessions now post start/completion comments and add/remove a `claude-working` label. The `/next-issue` slash command picks up the highest-priority open issue automatically.

**Pages:** None

**Model:** sonnet-4

**Duration:** ~25min

**Issues encountered:**
- None

**Learnings/notes:**
- `crux issues start <N>` / `crux issues done <N>` are the canonical way to signal activity
- The `claude-working` label is auto-created if it doesn't exist
- Priority is inferred from labels (P0/P1/P2/P3 or priority:high/medium/low) with age as tiebreaker
