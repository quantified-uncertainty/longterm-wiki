# Session Logging

Before your final commit in any session, create a session summary file in `.claude/sessions/`.

## File naming

```
.claude/sessions/YYYY-MM-DD_<branch-suffix>.md
```

Where `<branch-suffix>` is the branch name without the `claude/` prefix (e.g., for branch `claude/fix-bug-Abc12`, use `fix-bug-Abc12`).

## Format

```
## YYYY-MM-DD | branch-name | short-title

**What was done:** 1-2 sentence summary of the changes made.

**Issues encountered:**
- List any problems, errors, or unexpected behavior (or "None")

**Learnings/notes:**
- Anything a future session should know (or "None")
```

## Rules

- Keep entries concise (5-10 lines max)
- Always include the branch name so entries can be correlated with PRs
- If you encountered an issue that seems likely to recur, also add it to `.claude/common-issues.md`
- Do NOT skip logging just because the session was small — even one-line fixes are worth tracking
- The session log file should be part of the same commit as your other changes (not a separate commit)
- Each session gets its own file — this avoids merge conflicts between parallel sessions
