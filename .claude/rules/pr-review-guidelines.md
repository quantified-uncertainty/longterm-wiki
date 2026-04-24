# PR Review & Ship Workflow — MANDATORY

Before considering any session complete, you MUST execute the review-and-ship workflow. Do not skip steps. Do not ask the user whether to do this — it is always required.

## Shell safety: temp files

**Never use `>` to write temp files** — zsh `noclobber` prevents overwriting. Use `>|` (force overwrite) or `mktemp`. Better yet, pipe PR bodies directly via heredoc stdin:

```bash
# GOOD: pipe directly
pnpm crux gh pr create --title="..." <<'PRBODY'
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

## CodeRabbit "Addressed in commit X" markers — DO NOT TRUST

CodeRabbit sometimes appends `✅ Addressed in commit <sha>` to its review threads when it thinks a follow-up commit fixed the finding. Empirically these markers are **unreliable** in two ways:

1. **The referenced SHA may not exist.** Saw `✅ Addressed in commit 3d5cbbe` on PR #4538 (ford-foundation, protect-democracy duplicate-fact findings) and `✅ Addressed in commits 760b1ba to 2ce2219` on PR #4482 (swap-fk-target findings). `git show` returned `unknown revision` for both. CodeRabbit was confidently citing phantom commits.
2. **Even when the SHA exists, the relevant code may not actually reflect the fix.** PR #4482 finding 3 (information_schema joins missing schema) was marked addressed but the joins still matched on `constraint_name` only — the partial WHERE-clause hardening that did land was unrelated and didn't address the original concern.

**Always verify** before treating a finding as resolved:

```bash
# 1. Confirm the cited commit exists
git show <sha> --stat

# 2. Grep the current file for the bug pattern the finding flagged
grep -n "<bad-pattern>" <path>

# 3. If both are clean, the finding is genuinely addressed.
#    Otherwise treat it as an outstanding finding regardless of the marker.
```

This applies whether you're reviewing a teammate's PR, addressing comments on your own PR, or deciding whether to merge — the marker has no authority on its own.

## Ending a session

Every session should end with one of:

| Command | When to use |
|---------|-------------|
| `/agent-ship` | Shipping a PR — builds, reviews, pushes, monitors CI, closes session |
| `/agent-end` | No PR to ship — research, abandoned work, maintenance, PR patrol |

**`/agent-ship`** verifies the agent checklist (from `/agent-init`), polishes the PR description, updates GitHub issues, and calls `/agent-push-and-verify` to ship.

**`/agent-end`** is the lightweight close — marks the session completed, updates issue labels, removes local artifacts (wip-checklist, review-done, wip-context).

If `/agent-init` was not run (e.g., a quick fix session), either command will still work — `/agent-ship` generates a checklist on the fly, `/agent-end` just cleans up.

As a bare minimum, always open a PR before considering code work complete.

## Deploy task detection

Before opening a PR, run `pnpm crux gh deploy-tasks detect` to check for post-deploy requirements. If tasks are detected, inject them into the PR description with `pnpm crux gh deploy-tasks inject --pr=<N>`. The `/agent-session-ready-PR` skill handles this automatically.

The deploy task system auto-detects: new migrations, manual SQL scripts, new env vars, GitHub Actions changes, schema changes, config changes, new API routes, build pipeline changes, and Docker changes. For anything the detector misses, add tasks manually to the `## Deploy Checklist` section.

When merging a release PR (main→production), run `/deploy` to collect all deploy tasks from included PRs, monitor deployment, and verify tasks.

## Post-merge verification

When a PR changes infrastructure, CI config, Vercel settings, GitHub Actions, DNS, or any behavior that **cannot be verified by `pnpm build` + `pnpm test`**, consider adding an entry to `.claude/audits.yaml`:

- **One-time verification** (`post_merge` section): "After this merges, check that X actually happened." Include the PR number, what to verify, and a deadline.
- **Ongoing audit** (`audits` section): If the property should be monitored permanently (e.g., "scheduled workflows keep running"), add it as an ongoing audit item.

Run `pnpm crux sys audits list` to see current items. The maintenance sweep includes overdue audits in its report automatically.
