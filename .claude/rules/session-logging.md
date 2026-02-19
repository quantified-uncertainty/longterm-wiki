# Session Logging

Before your final commit in any session, create a session summary file in `.claude/sessions/`.

## File naming

```
.claude/sessions/YYYY-MM-DD_<branch-suffix>.yaml
```

Where `<branch-suffix>` is the branch name without the `claude/` prefix (e.g., for branch `claude/fix-bug-Abc12`, use `fix-bug-Abc12`).

## Format

```yaml
date: 2026-02-19
branch: claude/fix-bug-Abc12
title: Short session title
model: sonnet-4
duration: ~45min
pages:
  - page-id-1
  - page-id-2
summary: >
  1-2 sentence summary of the changes made.
pr: 123
issues:
  - List any problems, errors, or unexpected behavior
learnings:
  - Anything a future session should know
recommendations:
  - Infrastructure improvements discovered during the session (or omit if none)
```

## Rules

- Keep entries concise (5-10 lines max)
- Always include the branch name so entries can be correlated with PRs
- **Always include the `pages:` field** listing the page IDs (filenames without `.mdx`) of any wiki pages created or edited in the session. Use the page slug (e.g., `ai-risks`, `compute-governance`), not the full path. Use an empty list `pages: []` if no content pages were changed (infrastructure-only work).
- **The `pr:` field is optional** — PR numbers are auto-populated at build time by looking up branches via the GitHub API (`apps/web/scripts/lib/github-pr-lookup.mjs`). You can include `pr: 123` manually as an override, but it's not required.
- **Always include the `model:` field** with the short model name (e.g., `opus-4-6`, `sonnet-4`, `sonnet-4-5`). This is the LLM model powering the session. Check the system prompt for "You are powered by the model named..." to find the current model ID.
- **Always include the `duration:` field** with an approximate session duration (e.g., `~15min`, `~45min`, `~2h`). Estimate based on how much work was done — a single small fix is ~10-15min, a multi-file feature is ~30-60min, a large refactor or page creation session is ~1-2h+.
- **The `cost:` field is optional** — include it when the session used the content pipeline (`crux content create/improve`) since tiers map to approximate costs (budget ~$2-3, standard ~$5-8, premium ~$10-15). For infrastructure-only sessions, omit this field.
- If you encountered an issue that seems likely to recur, also add it to `.claude/common-issues.md`
- Do NOT skip logging just because the session was small — even one-line fixes are worth tracking
- The session log file should be part of the same commit as your other changes (not a separate commit)
- Each session gets its own file — this avoids merge conflicts between parallel sessions
- **The `recommendations:` field is optional** — include actionable infrastructure improvement suggestions discovered during the session. These are notes for future sessions, not tasks to do now.
- **Format is machine-parsed**: The `date`, `branch`, `title`, `pages`, `pr`, `model`, `duration`, and `cost` fields are parsed by `apps/web/scripts/lib/session-log-parser.mjs` to build the `/internal/page-changes` dashboard. Validated by Zod schema in `crux/validate/validate-session-logs.ts`.
- **Validation**: Run `pnpm crux validate session-logs` to check all session log files for schema compliance. Errors (missing required fields, invalid YAML) block; warnings (missing model/duration) are advisory.
- **Migration**: Legacy `.md` session logs are still supported by the parser. Convert them to YAML with `node scripts/migrate-session-logs.mjs --apply`.
