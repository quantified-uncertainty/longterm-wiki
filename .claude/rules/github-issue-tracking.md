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

## Dedup check — `crux linear start` refuses competing claims

Both `crux linear start QUA-NNN` and `crux sys agent-checklist init --linear=QUA-NNN` run a **dedup pre-check** before posting anything to Linear. The check looks for two signals that another session is already working on the issue:

1. **Recent start comments** — A `🤖 Claude Code starting work` comment posted in the last 24h from a **different slot** (e.g., a9 while you're on a5), not yet superseded by a `🤖 Claude Code finished work` comment.
2. **Open PRs** — Any open PR in the wiki repo whose title or body mentions the Linear ID.

Either signal is sufficient to block. On a collision, both commands exit with **code 2** (distinct from 1 for other errors), print the detected claim(s)/PR(s), and refuse to write any local session state (checklist file, DB row, active-agent registration). This means a colliding `init` leaves **no artifact** — you can fix the race and re-run without cleanup.

Re-running from the **same slot** is NOT a collision — it's treated as session resumption (init-crash recovery, etc.). The slot is derived from the `a<N>` ancestor of the current working directory.

Both checks are **fail-open**: if the Linear or GitHub API is unreachable, the dedup helper returns empty and the start proceeds. A transient API glitch should not wedge every session on the machine. The downside is a rare missed collision when both APIs are down simultaneously.

### Bypassing with `--force`

If the other session is genuinely abandoned or you have explicit permission to take over, pass `--force`:

```bash
pnpm crux linear start QUA-NNN --force
# or
pnpm crux sys agent-checklist init "..." --linear=QUA-NNN --force
```

`--force` **skips** the dedup check entirely. The start comment is annotated with a visible `⚠ Claimed with --force` marker so the duplication is captured in Linear history.

### Historical note — QUA-406

The dedup check was added after a 2026-04-13 incident where two concurrent sessions on the same machine (slots a9 and a16) each shipped a competing PR for QUA-397. Prior to that, `crux linear start` unconditionally posted a start comment regardless of existing claims, and the session-tracking rule described below was aspirational. See QUA-406 for the full post-mortem and fix set.

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
- The dedup check (above) prevents multiple sessions from picking up the same issue simultaneously. Without it, two agents can spend hours independently shipping competing PRs for the same ticket (QUA-406 incident)
- Creates a paper trail connecting branches/PRs to the originating issue
- `crux` commands validate for corruption — raw curl/jq commands are vulnerable to shell-expansion bugs

## Edge Cases

- If `LINEAR_API_KEY` is not set, skip the Linear API calls and note this in the session log. Fall back to GitHub if `GITHUB_TOKEN` is available.
- If the issue number cannot be determined from the task description, skip this workflow
- The `/agent-next-issue` command handles start tracking automatically
