# GitHub Issue Tracking — MANDATORY

When a Claude Code session is assigned to work on a specific GitHub issue, it MUST signal its activity on that issue so humans can track progress and avoid duplicate work.

## At Session Start

When the task description references a GitHub issue number (e.g., "resolve issue #239", "fix #239", "work on https://github.com/.../issues/239"), run this **before writing any code**:

```bash
pnpm crux issues start <ISSUE_NUM>
```

This posts a start comment on the issue and adds the `claude-working` label. The label is created automatically if it doesn't exist yet.

**Do NOT use raw curl/GitHub API calls for issue tracking.** Always use `crux issues` commands — they route through `githubApi()` which validates request bodies for shell-expansion corruption before sending to GitHub.

## At Session End (when shipping)

After the work is committed and pushed (via `/push-and-ensure-green`), signal completion:

```bash
pnpm crux issues done <ISSUE_NUM> --pr=<PR_URL>
```

This posts a completion comment and removes the `claude-working` label.

## PR Management

Use `crux pr` commands instead of raw curl for all PR operations:

```bash
pnpm crux pr detect              # Check if PR exists for current branch
pnpm crux pr create --title="..." --body="..."  # Create PR (corruption-safe)
pnpm crux pr fix-body            # Auto-fix literal \n in PR body
```

## Why This Matters

- Humans can see at a glance which issues are being handled
- Prevents multiple sessions picking up the same issue simultaneously
- The `claude-working` label enables filtering in the GitHub issues list
- Creates a paper trail connecting branches/PRs to the originating issue
- `crux` commands validate for corruption — raw curl/jq commands are vulnerable to shell-expansion bugs

## Edge Cases

- If `GITHUB_TOKEN` is not set, skip the API calls and note this in the session log
- If the issue number cannot be determined from the task description, skip this workflow
- The `/next-issue` command handles start tracking automatically — no need to do it manually when using that workflow
