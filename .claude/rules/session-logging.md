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

**Model:** opus-4-6

**Duration:** ~45min

**Cost:** ~$5

**Issues encountered:**
- List any problems, errors, or unexpected behavior (or "None")

**Learnings/notes:**
- Anything a future session should know (or "None")

**Recommendations:**
- Infrastructure improvements discovered during the session (or omit if none)
```

## Rules

- Keep entries concise (5-10 lines max)
- Always include the branch name so entries can be correlated with PRs
- **Always include the `Pages:` field** listing the page IDs (filenames without `.mdx`) of any wiki pages created or edited in the session. Use the page slug (e.g., `ai-risks`, `compute-governance`), not the full path. Omit the field only if the session made no page content changes (infrastructure-only work).
- **The `PR:` field is optional** — PR numbers are auto-populated at build time by looking up branches via the GitHub API (`app/scripts/lib/github-pr-lookup.mjs`). You can include `**PR:** #123` manually as an override, but it's not required.
- **Always include the `Model:` field** with the short model name (e.g., `opus-4-6`, `sonnet-4`, `sonnet-4-5`). This is the LLM model powering the session. Check the system prompt for "You are powered by the model named..." to find the current model ID.
- **Always include the `Duration:` field** with an approximate session duration (e.g., `~15min`, `~45min`, `~2h`). Estimate based on how much work was done — a single small fix is ~10-15min, a multi-file feature is ~30-60min, a large refactor or page creation session is ~1-2h+.
- **The `Cost:` field is optional** — include it when the session used the content pipeline (`crux content create/improve`) since tiers map to approximate costs (budget ~\$2-3, standard ~\$5-8, premium ~\$10-15). For infrastructure-only sessions, omit this field.
- If you encountered an issue that seems likely to recur, also add it to `.claude/common-issues.md`
- Do NOT skip logging just because the session was small — even one-line fixes are worth tracking
- The session log file should be part of the same commit as your other changes (not a separate commit)
- Each session gets its own file — this avoids merge conflicts between parallel sessions
- **The `Recommendations:` field is optional** — include actionable infrastructure improvement suggestions discovered during the session. Format: "The X system could be improved by Y." These are notes for future sessions, not tasks to do now.
- **Format is machine-parsed**: The `## date | branch | title` heading, `**Pages:**`, `**PR:**`, `**Model:**`, `**Duration:**`, and `**Cost:**` fields are parsed by `app/scripts/lib/session-log-parser.mjs` to build the `/internal/page-changes` dashboard. If you change the format here, update the parser and its tests too.
- **Validation**: Run `pnpm crux validate session-logs` to check all session log files for format compliance. Errors (missing heading, missing "What was done") block; warnings (missing Model/Duration) are advisory.
