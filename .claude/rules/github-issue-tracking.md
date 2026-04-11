# Issue Tracking — MANDATORY

**Linear is the primary issue tracker.** GitHub Issues are legacy and should not be used for new issues. All new bugs, features, and tasks go in Linear (QUA team).

When a Claude Code session is assigned to work on an issue, it MUST signal its activity so humans can track progress and avoid duplicate work.

## At Session Start

When the task references an issue (Linear QUA-NNN or legacy GitHub #NNN), run this **before writing any code**:

```bash
# Linear issue (primary — most issues):
pnpm crux linear start QUA-NNN

# Legacy GitHub issue (only if the issue is already tracked there):
pnpm crux gh issues start <ISSUE_NUM>
```

For Linear: moves the issue to "In Progress" and posts a start comment.
For GitHub: posts a start comment and adds the `agent:working` label.

**Note:** `crux sys agent-checklist init` handles both automatically when `--linear=QUA-NNN` or `--issue=N` is provided. You rarely need to call these manually.

## At Session End (when shipping)

After the work is committed and pushed (via `/agent-push-and-verify`), signal completion:

```bash
# Linear (primary):
pnpm crux linear done QUA-NNN --pr=<PR_URL>

# Legacy GitHub (only if the issue is tracked there):
pnpm crux gh issues done <ISSUE_NUM> --pr=<PR_URL>
```

## Filing New Issues

**Always file in Linear**, not GitHub:

```bash
# Search first:
pnpm crux linear search "your topic here"

# Create:
pnpm crux linear create "Descriptive title" --description="What's wrong and why it matters"
```

Do NOT use `gh issue create` or `pnpm crux gh issues create` for new issues. See `.claude/rules/proactive-issue-filing.md` for when and how to file.

## PR Management (stays on GitHub)

PRs, CI, and code review remain on GitHub. Use `crux gh pr` commands:

```bash
pnpm crux gh pr detect              # Check if PR exists for current branch
pnpm crux gh pr fix-body            # Auto-fix literal \n in PR body

# For multi-line PR bodies, use stdin or --body-file (NOT inline --body with heredoc):
pnpm crux gh pr create --title="..." --body-file=/tmp/pr-body.md
# or:
pnpm crux gh pr create --title="..." <<'PRBODY'
## Summary
- key change 1
PRBODY
```

## Why This Matters

- Linear is the source of truth for project status — stale "In Progress" issues mislead the team
- Prevents multiple sessions picking up the same issue simultaneously
- Creates a paper trail connecting branches/PRs to the originating issue
- `crux` commands validate for corruption — raw curl/jq commands are vulnerable to shell-expansion bugs

## Edge Cases

- If `LINEAR_API_KEY` is not set, skip the Linear API calls and note this in the session log. Fall back to GitHub if `GITHUB_TOKEN` is available.
- If the issue number cannot be determined from the task description, skip this workflow
- The `/agent-next-issue` command handles start tracking automatically
