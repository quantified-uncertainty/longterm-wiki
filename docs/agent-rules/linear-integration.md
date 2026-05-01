# Linear Integration

Subsystem map for the Linear-GitHub integration: auto-close, branch naming, PR injection, and agent commands. **Read this before working on a Linear-tracked issue or touching `crux linear` / `crux gh pr create`** -- agents repeatedly miss the branch-naming requirement and Linear issues stay open after merge.

## Why this file exists

Linear's GitHub integration auto-moves issues to Done on PR merge, but **only when it can link the PR to the issue**. The linking requires either the branch name or PR body to contain the Linear ID. Agents who skip the `qua-NNN` branch pattern silently break auto-close, leaving stale "In Progress" issues in the backlog.

---

## 1. How auto-close works

Linear's native GitHub integration (installed at the org level) watches for PR merges and moves linked issues to Done. Linking happens via two mechanisms:

| Mechanism | Example | Reliability |
|-----------|---------|-------------|
| **Branch name** contains `qua-NNN` | `claude/qua-184-linear-integration` | Primary -- always works |
| **PR body** contains `Fixes QUA-NNN` | `Fixes QUA-184` | Fallback -- injected automatically by `crux gh pr create` |

Both are case-insensitive. `Closes QUA-NNN` and `Resolves QUA-NNN` also work.

**If neither is present, the issue stays open after merge.** This is the #1 failure mode.

## 2. Branch naming convention

For Linear issues, encode the ID in the branch name:

```
claude/qua-NNN-short-description
```

Examples:
- `claude/qua-184-linear-integration`
- `claude/qua-233-linear-integration-doc`

**Why the branch name matters most**: Linear's GitHub integration links PRs by branch name before it parses the PR body. The branch name is set once at session start and can't be forgotten. The PR body injection is a safety net, not the primary mechanism.

`agent-checklist init` auto-detects `qua-NNN` from the branch name and warns if the branch doesn't contain the Linear ID:

```
Warning: Branch "claude/tier0-data-integrity" does not contain the Linear ID QUA-155.
  Linear's GitHub integration won't auto-close the issue on PR merge.
  Suggested: git checkout -b claude/qua-155-tier0-data-integrity
```

## 3. `crux gh pr create` auto-injection

When creating a PR, `crux gh pr create` automatically injects `Fixes QUA-NNN` into the PR body. It collects Linear IDs from three sources (in priority order):

1. **Branch name** -- parsed by `parseLinearId()` from `crux/lib/linear/parse-id.ts`
2. **`--linear=QUA-NNN,QUA-NNN` flag** -- explicit, supports multiple IDs for epics
3. **`.claude/wip-checklist.md` metadata** -- the `> Linear: QUA-NNN` line written by `agent-checklist init`

IDs already referenced in the body (`Fixes`, `Closes`, `Resolves`) are skipped to avoid duplicates.

**Always use `crux gh pr create`**, not raw `gh pr create`. The crux wrapper handles Linear injection, body corruption detection, and GitHub API validation. The agent-push-and-verify skill enforces this.

### Pre-PR Linear dedup (QUA-304)

After injecting Linear refs, `crux gh pr create` extracts every `Fixes|Closes|Resolves QUA-NNN` from the final PR body and searches GitHub for other **open** PRs that already reference any of those IDs. If any match, the command exits with code 2 and lists the colliding PRs — no PR is created. This is the last line of defense when two sessions race on the same Linear ticket and `crux linear start`'s dedup (QUA-406/440) was bypassed or never ran (e.g. the second session didn't know the Linear ID until PR creation).

To bypass the check (existing PR abandoned, explicit handoff, etc.) re-run with `--force`. The check fails open on GitHub API errors — a search outage doesn't wedge PR creation.

## 4. Agent workflow state transitions

The `crux linear` commands manage issue state through the agent session lifecycle:

| Session phase | Command | Linear state | Who calls it |
|---------------|---------|-------------|--------------|
| Start | `crux linear start QUA-NNN` | In Progress | Auto-called by `agent-checklist init` |
| Ship (PR exists) | `crux linear done QUA-NNN --pr=URL` | In Review | `/agent-ship` step 5b |
| End (no PR) | `crux linear done QUA-NNN` | Done | `/agent-end` step 2b |
| PR merges | *(automatic)* | Done | Linear's GitHub integration |

**State flow**: Backlog/Todo --> In Progress --> In Review --> Done

`crux linear done` behavior:
- **With `--pr=URL`**: moves to "In Review" (the PR merge will move it to Done via Linear's integration)
- **Without `--pr`**: moves straight to "Done" (for research, abandoned work, docs-only sessions)

Note: `crux linear done` does NOT auto-detect open PRs on the current branch. If a PR exists, you must pass `--pr=URL` explicitly. The `/agent-ship` and `/agent-end` skills handle this automatically.

## 5. Git automation rules (configured in Linear)

Linear has built-in Git automation that triggers state changes independent of the `crux` commands:

| Git event | Linear action |
|-----------|---------------|
| Branch created with `qua-NNN` | Issue moves to In Progress |
| PR review requested | Issue moves to In Review |
| PR merged | Issue moves to Done |

These are configured in Linear's team settings (not in this repo). The `crux` commands duplicate some of these transitions intentionally -- belt-and-suspenders for cases where Linear's automation doesn't fire (e.g., branch created before Linear integration was installed, or PR body reference without branch name match).

**The In-Review → Done transition is empirically unreliable.** Even when a PR has both a `claude/qua-NNN-*` branch name AND a `Fixes QUA-NNN` body line, ~1.4–5% of merged PRs leave their issue stuck in "In Review" indefinitely (QUA-812 measurement). The fallback is `crux linear audit --fix` (see § 6), which classifies any active issue (In Progress + In Review) with a merged PR as `shipped` and moves it to Done. Run after every batch of merges, or include it in the maintenance sweep.

## 6. Available commands

```bash
# View and search
crux linear view QUA-NNN              # Show full issue + recent comments
crux linear search <query>            # Search QUA team issues
crux linear parse <string>            # Extract Linear ID from a string (debug)

# State management
crux linear start QUA-NNN             # Move to In Progress + post start comment
crux linear done QUA-NNN [--pr=URL]   # Move to In Review (with PR) or Done

# Communication
crux linear comment QUA-NNN <message>           # Post a comment
crux linear comment QUA-NNN --body-file=<path>  # Comment from file (multiline-safe)

# Maintenance
crux linear audit                     # Classify active issues (In Progress + In Review) by PR health
crux linear audit --fix               # Auto-close SHIPPED + PARENT-EPIC (covers In-Review → Done failures, QUA-812)
crux linear audit --bucket=shipped --json  # Machine-readable shipped list

# Stale-claim sweep (QUA-815)
crux linear release-stale [--dry-run] [--stale-minutes=N] [--limit=N] [--json]

# Admin
crux linear states-list               # Show current QUA team workflow state IDs
```

**Environment**: requires `LINEAR_API_KEY` (synced from `.env.base` at the workspace root). All Linear calls are best-effort in the agent pipeline -- a missing key or network error never blocks `agent-checklist init` or `/agent-ship`.

## 6a. Stale-claim sweep — `crux linear release-stale` (QUA-815)

Sometimes an agent runs `crux sys agent-checklist init --linear=QUA-NNN`, posts the `🤖 Claude Code starting work` claim comment, and then **crashes before creating `claude/qua-NNN-*` and pushing a PR** — out-of-context, kernel kill, network drop. The PG `agent_sessions` heartbeat shows the session is dead, but Linear stays "In Progress" indefinitely. This pollutes dispatch decisions: a coordinator running pre-flight (`docs/agent-rules/dispatched-agent-review.md` § Dispatcher pre-flight) sees "ticket already In Progress" and skips dispatch, even though no work is happening.

`crux linear release-stale` finds these claims and auto-releases them. Per candidate it runs three protective checks before acting:

1. **Branch on origin** — if `git ls-remote --heads origin claude/qua-NNN claude/qua-NNN-*` returns any ref, skip. This protects long-running parent epics like QUA-408 (data-model unwind) that always have *some* branch in flight.
2. **Open PR mention** — if any open PR in the wiki repo references the ticket in title or body, skip. Broader than the close-keyword search the audit uses (`Fixes QUA-NNN`) — even a `follow-up to QUA-NNN` mention should protect the ticket.
3. **Linear state** — only acts when `state.type === 'started'` (In Progress / In Review). Tickets in `triage`, `completed`, `canceled`, `backlog`, `unstarted` are skipped — we don't re-open closed work, and we don't second-guess human triage.

Surviving candidates get a `🤖 Auto-released claim — session went stale without producing a branch.` comment + a state move to **Backlog**. The session row stays as-is (the periodic `crux sys agents sweep` flips it to `status='stale'` independently).

```bash
# Preview without mutating Linear:
WIKI_SERVER_ENV=prod pnpm crux linear release-stale --dry-run

# Run it (default 30-min staleness window, 100-candidate cap):
WIKI_SERVER_ENV=prod pnpm crux linear release-stale

# Tighter window, larger batch:
WIKI_SERVER_ENV=prod pnpm crux linear release-stale --stale-minutes=120 --limit=200
```

Source: `crux/lib/linear/release-stale-claims.ts` + `crux/commands/linear.ts::releaseStale`. Backed by `GET /api/agent-sessions/stale-claims` (returns `linear_id IS NOT NULL AND status != 'completed' AND updated_at < cutoff`).

## 7. ID parsing -- `parseLinearId()`

The parser in `crux/lib/linear/parse-id.ts` uses an allowlist of known team keys (currently just `QUA`) to avoid false positives:

- `claude/qua-184-description` --> `QUA-184` (branch pattern)
- `"Work on QUA-184"` --> `QUA-184` (bare token)
- `claude/fix-239-broken-scoring` --> `null` (not a known team key)
- `CVE-2024-12345` --> `null` (not a known team key)

`resolveLinearId([branch, taskDescription])` tries multiple sources in order, returning the first match. Used by `agent-checklist init` for auto-detection.

## 8. Common mistakes to avoid

| Mistake | Consequence | Fix |
|---------|------------|-----|
| Branch `claude/tier0-data-integrity` instead of `claude/qua-155-tier0-data-integrity` | Linear issue stays open after merge | Always include `qua-NNN` in branch name |
| Using raw `gh pr create` | No `Fixes QUA-NNN` injection, no corruption detection, no pre-PR dedup (QUA-304) | Use `crux gh pr create` |
| Calling `crux linear done QUA-NNN` without `--pr` when a PR exists | Issue goes to Done instead of In Review; skips the merge-triggered auto-close | Pass `--pr=URL` when shipping a PR |
| Forgetting `LINEAR_API_KEY` | Silent skip of all Linear state updates | Sync `.env.base` or `export LINEAR_API_KEY=...` |
| Manually moving issues in Linear UI during active agent session | Agent's `crux linear done` may override the manual state | Let the agent pipeline manage state |
| Bypassing pre-PR dedup with `--force` without investigating the other PR | Two PRs racing on the same Linear ticket | Read the other PR first; reconcile or close before forcing |

## 9. Project ownership — which project does an issue belong in?

See **`docs/agent-rules/linear-project-ownership.md`** for the decision rules on which of the 6 open QUA projects a new issue belongs in. The boundaries between Automation & Infrastructure, Source-Check & Verification, Data Integrity, Dashboards & Visibility, Content Quality & Enrichment, and Coordinator & Agent Tooling are non-obvious and get crossed repeatedly without an explicit doctrine. File new issues with a project from the start — orphans accumulate and the 2026-04-14 refactor pass had to move 22 issues between projects.

**Hygiene scan**: `pnpm crux linear hygiene` reports orphan issues, label drift, priority gaps, and stuck tickets. Run quarterly (or when the backlog feels messy) to catch drift. Source: `crux/lib/linear/hygiene.ts`. Full refactor history: [`docs/audits/2026-04-14-linear-refactor.md`](../audits/2026-04-14-linear-refactor.md).

## 10. Key files

| File | Purpose |
|------|---------|
| `crux/commands/linear.ts` | Command implementations (view, search, comment, start, done) |
| `crux/lib/linear/client.ts` | GraphQL client with corruption detection, 15s timeout |
| `crux/lib/linear/parse-id.ts` | `parseLinearId()`, `resolveLinearId()`, team key allowlist |
| `crux/lib/linear/workflow-states.ts` | QUA team workflow state IDs, `getWorkflowStateId()` |
| `crux/lib/linear/issues.ts` | `getIssue()`, `searchIssues()`, `commentOnIssue()`, `updateIssueState()` |
| `crux/lib/linear/release-stale-claims.ts` | QUA-815 stale-claim sweep — branch + PR + state checks before auto-release |
| `apps/wiki-server/src/routes/operational/agent-sessions.ts` | `GET /stale-claims` endpoint that the sweep consumes |
| `crux/commands/pr.ts` | `injectLinearRefs()` -- auto-injection into PR bodies |
| `.claude/commands/agent-ship.md` | Step 5b -- Linear done on ship |
| `.claude/commands/agent-end.md` | Step 2b -- Linear done on end |
