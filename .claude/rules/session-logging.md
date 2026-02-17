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

**Pages:** page-id-1, page-id-2

**PR:** #123

**Issues encountered:**
- List any problems, errors, or unexpected behavior (or "None")

**Learnings/notes:**
- Anything a future session should know (or "None")
```

## Rules

- Keep entries concise (5-10 lines max)
- Always include the branch name so entries can be correlated with PRs
- **Always include the `Pages:` field** listing the page IDs (filenames without `.mdx`) of any wiki pages created or edited in the session. Use the page slug (e.g., `ai-risks`, `compute-governance`), not the full path. Omit the field only if the session made no page content changes (infrastructure-only work).
- **The `PR:` field is optional** — PR numbers are auto-populated at build time by looking up branches via the GitHub API (`app/scripts/lib/github-pr-lookup.mjs`). You can include `**PR:** #123` manually as an override, but it's not required.
- If you encountered an issue that seems likely to recur, also add it to `.claude/common-issues.md`
- Do NOT skip logging just because the session was small — even one-line fixes are worth tracking
- The session log file should be part of the same commit as your other changes (not a separate commit)
- Each session gets its own file — this avoids merge conflicts between parallel sessions
- **Format is machine-parsed**: The `## date | branch | title` heading, `**Pages:**` field, and `**PR:**` field are parsed by `app/scripts/lib/session-log-parser.mjs` to build the `/internal/page-changes` dashboard. If you change the format here, update the parser and its tests too.
