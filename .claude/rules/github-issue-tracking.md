# Issue Tracking — MANDATORY

**Linear is the primary issue tracker.** GitHub Issues are legacy. All new bugs, features, and tasks go in Linear (QUA team).

## Session start / end

Signaling start and done is **handled automatically** by `pnpm crux sys agent-checklist init` (start) and `/agent-ship` / `/agent-end` (done) when a Linear ID or GitHub issue is detected from the branch name (`claude/qua-NNN-*`) or passed via `--linear=QUA-NNN` / `--issue=N`. You rarely need to call `crux linear start/done` or `crux gh issues start/done` by hand.

## Dedup pre-check

`crux linear start` and `crux sys agent-checklist init --linear=QUA-NNN` refuse competing claims (exit 2). Three signals are consulted: PG `agent_sessions` (authoritative), Linear start comments, then open PRs. To override a stale claim: `--force` (annotates Linear with a `⚠ Claimed with --force` marker). See `pnpm crux linear --help` for the full source order and rationale, or `docs/agent-rules/linear-integration.md` for QUA-406/QUA-440 history.

**Coordinators dispatching to a slot:** the dedup check fires in the slot, not in the coordinator. The coordinator has separate pre-flight responsibilities — see `.claude/rules/dispatched-agent-review.md` § "Dispatcher pre-flight".

## Filing new issues

Always file in Linear, not GitHub. Search before creating. `--project` is required (or inherited via `--parent`):

```bash
pnpm crux linear search "your topic here"
pnpm crux linear create "Descriptive title" --description="..." --project="<Project Name>"
```

Do NOT use `gh issue create` or `pnpm crux gh issues create` for new issues. See `.claude/rules/proactive-github-filing.md` for what merits a ticket and `.claude/rules/linear-project-ownership.md` to pick the right project.

## PR management (stays on GitHub)

PRs, CI, and code review remain on GitHub. Use `crux gh pr` commands — never raw curl. Use `--body-file` or stdin heredoc for multi-line bodies (inline `--body="$(cat <<EOF...)"` fails with `/bin/sh`):

```bash
pnpm crux gh pr create --title="..." <<'PRBODY'
## Summary
- key change 1
PRBODY
```

`crux gh pr fix-body` repairs literal `\n` in PR bodies. `crux gh pr detect` checks if a PR exists for the current branch.

## Edge cases

- If `LINEAR_API_KEY` is unset, Linear calls are skipped and the session log notes it. Falls back to GitHub when `GITHUB_TOKEN` is available.
- If the issue number cannot be determined from the task description, the workflow is skipped.
- `/agent-next-issue` handles start tracking automatically.
