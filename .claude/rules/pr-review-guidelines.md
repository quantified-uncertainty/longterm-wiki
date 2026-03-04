# PR Review & Ship Workflow — MANDATORY

Before considering any session complete, you MUST execute the review-and-ship workflow. Do not skip steps. Do not ask the user whether to do this — it is always required.

## Shell safety: temp files

**Never use `>` to write temp files** — zsh `noclobber` prevents overwriting. Use `>|` (force overwrite) or `mktemp`. Better yet, pipe PR bodies directly via heredoc stdin:

```bash
# GOOD: pipe directly
pnpm crux pr create --title="..." <<'PRBODY'
body here
PRBODY

# GOOD: force overwrite
cat >| /tmp/pr-body.md <<'PRBODY'
body here
PRBODY

# BAD: fails silently with noclobber, uses stale file content
cat > /tmp/pr-body.md <<'PRBODY'
body here
PRBODY
```

## GitHub issue auto-close syntax

When a PR closes GitHub issues, use **one `Closes #N` per line** in the PR body. A comma-separated list (`Closes #1, #2, #3`) is **not** reliably recognized by GitHub and will only close the first issue.

```
Closes #529
Closes #530
Closes #533
Closes #538
```

## Preferred: `/agent-session-ready-PR`

The recommended end-of-session command is `/agent-session-ready-PR`. It verifies the agent checklist (from `/agent-session-start`), polishes the PR description, updates GitHub issues, creates a session log, and calls `/push-and-ensure-green` to ship.

If `/agent-session-start` was run at session start and `.claude/wip-checklist.md` exists, just run `/agent-session-ready-PR` — it handles everything.

## Fallback: Quick fix sessions

If `/agent-session-start` was not run (e.g., a quick fix session), run `/agent-session-ready-PR` directly — it will generate a checklist on the fly if one doesn't exist, then walk through completion and shipping.

As a bare minimum, always open a PR before considering work complete.

## Post-merge verification

When a PR changes infrastructure, CI config, Vercel settings, GitHub Actions, DNS, or any behavior that **cannot be verified by `pnpm build` + `pnpm test`**, consider adding an entry to `.claude/audits.yaml`:

- **One-time verification** (`post_merge` section): "After this merges, check that X actually happened." Include the PR number, what to verify, and a deadline.
- **Ongoing audit** (`audits` section): If the property should be monitored permanently (e.g., "scheduled workflows keep running"), add it as an ongoing audit item.

Run `pnpm crux audits list` to see current items. The maintenance sweep includes overdue audits in its report automatically.
