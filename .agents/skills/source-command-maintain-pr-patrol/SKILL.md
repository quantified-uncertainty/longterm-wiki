---
name: "source-command-maintain-pr-patrol"
description: "Scan all open PRs for issues and fix them in priority order."
---

# source-command-maintain-pr-patrol

Use this skill when the user asks to run the migrated source command `maintain-pr-patrol`.

## Command Template

# PR Patrol

Scan all open PRs for issues and fix them in priority order.

**CONTINUOUS OPERATION:** After completing a scan+fix cycle, wait 2-3 minutes then scan again. Keep looping until the user says to stop or switches tasks. Do NOT stop after one pass and wait for re-invocation — "patrol" means continuous monitoring.

## Health gate — MANDATORY first step each cycle

Before scanning or fixing any PR, check fleet-level health. The daemon (`crux/pr-patrol/index.ts`) does this automatically at the start of `runCheckCycle`, but if you're running patrol by hand, invoke it explicitly:

```bash
pnpm exec tsx -e "import('./crux/pr-patrol/health-gate.ts').then(m => m.runHealthGate().then(d => { console.log(JSON.stringify({ proceed: d.proceed, reason: d.reason, emitted: d.emittedIssues.length }, null, 2)); process.exit(d.proceed ? 0 : 2); }))"
```

If the gate returns `proceed: false` (exit code 2), **do NOT then go fix PRs** — the gate's entire purpose is to stop the symptom-patch cycle. Note: `proceed: false` can result from any of three conditions, which emit different JSONL events (or none):

- **A new unhealthy fingerprint** → emits `health_gate_tripped` + `cycle_summary{health_gate_tripped: true}`.
- **All unhealthy fingerprints cooldown-suppressed** → still halts PR work, but emits only `cycle_summary{health_gate_tripped: true}` (no new `health_gate_tripped` event, because the same escalation was emitted within the last 30 min).
- **Third consecutive scanner error** → emits `health_scan_error` + halts. No `health_gate_tripped` in this path.

Check `~/.cache/pr-patrol/runs.jsonl` for the specific event to understand why the gate tripped before deciding how to respond.

When the gate is red, **DO NOT**:
- Bump a ratchet baseline to unblock a CI signal
- Revert a rename because endpoints are 404ing on prod (the deploy is probably stuck, not the rename)
- Dispatch an agent to fix a PR whose failure is a symptom of the fleet-level issue
- Merge a "fix the fix" PR into a pipeline that's already broken

Instead: escalate to the coordinator. The escalation reason names the specific subsystem (deploy pipeline, main CI, ratchet drift) and points at the prescriptive fix pattern. See `.claude/rules/patrol-health-gate.md`.

Emergency escape hatch: `PATROL_DISABLE_HEALTH_GATE=1` bypasses the gate entirely. Use ONLY when the gate itself is broken, never to work around a red prod.

## Branch Agent mode (Phase 1 — per-PR watchdog)

For PRs needing sustained attention, use **branch-agent** instead of waiting for the daemon:

```bash
pnpm crux gh pr-patrol branch-agent <PR#>   # Watch PR until fixed/merged
```

This runs multiple short fix sessions (15 min each) with CI waits between them.
Use this when a PR keeps timing out or needs several rounds of CodeRabbit feedback.

## Escalation order — automation first, human last

When fixing any PR, work through issues in this order:
1. **Fix code issues** — CI failures, merge conflicts, test failures
2. **Add labels you can verify** — e.g. `gate:rules-ok` if you've confirmed the rule is satisfied
3. **Address ALL bot comments** — CodeRabbit Critical/Major/Minor must be attempted, not skipped
4. **Complete unchecked checklist items** — update PR body when tasks are done
5. **Flag for human review** — only AFTER exhausting all automated fixes

## Phase 1: Scan all open PRs

Fetch all open PRs and detect issues:

```bash
gh pr list --repo quantified-uncertainty/longterm-wiki --state open --limit 50 \
  --json number,title,headRefName,mergeable,statusCheckRollup,updatedAt,body,labels
```

For each PR, check **ALL THREE** of these on every cycle (not just CI):

| Issue | Detection | Priority |
|-------|-----------|----------|
| **Merge conflict** | `mergeable == "CONFLICTING"` | P0 (score: 100) |
| **CI failure** | `statusCheckRollup` has `FAILURE` conclusion | P1 (score: 80) |
| **Bot review (major)** | Unresolved Major/Minor/Critical bot comment (CodeRabbit etc.) | P2 (score: 55) |
| **Missing issue reference** | PR body lacks `Closes #N` / `Fixes #N` | P2 (score: 40) |
| **Stale** (>48h no update) | `updatedAt` comparison | P3 (score: 30) |
| **Missing test plan** | PR body lacks `## Test plan` section | P3 (score: 20) |
| **Bot review (nitpick)** | Unresolved nitpick-only bot comments | P3 (score: 15) |

**CRITICAL: The scan loop MUST check unresolved review threads via GraphQL on every cycle.** Checking only `gh pr checks` for CI failures misses CodeRabbit threads entirely. Use this query every cycle:
```bash
gh api graphql -f query='{ repository(owner: "quantified-uncertainty", name: "longterm-wiki") { pullRequests(states: OPEN, first: 20) { nodes { number reviewThreads(first: 20) { nodes { isResolved } } } } } }' --jq '.data.repository.pullRequests.nodes[] | select(.reviewThreads.nodes | map(select(.isResolved == false)) | length > 0) | "PR #\(.number): \(.reviewThreads.nodes | map(select(.isResolved == false)) | length) unresolved"'
```

**Skip PRs with the `agent:working` label** — another session is already on them.

## Phase 2: Prioritize

Score each PR by summing the scores of its detected issues. Sort descending. Display the full queue:

```text
Priority queue (N items):
  [score=180] PR #123: conflict,ci-failure — Fix authentication flow
  [score=40]  PR #456: missing-issue-ref — Update entity types
```

### Cross-PR dependency chain (QUA-287 Phase 3)

When a PR appears to depend on another open PR (detected via GitHub cross-reference events or `#NNNN` tokens in CI/gate error output that validate against the open-PR list), the queue renders a dependency arrow:

```text
Priority queue (N items):
  [score=135] PR #4188: stuck                                    — Baseline schema bump
  [score=80]  PR #4157: ci-failure → blocked on #4188            — Feature A on new schema
  [score=80]  PR #4162: ci-failure → blocked on #4188, #4190     — Feature B on new schema
```

This surfaces "Miss #4" from QUA-284: when one baseline-bump PR holds up multiple siblings, the queue now makes that explicit. Sources of the cross-PR link (in order of trust):

1. **GitHub `CrossReferencedEvent` timeline items** (reason: `cross-referenced`) — most reliable; fired when another PR mentions this one.
2. **`#NNNN` tokens in failing check/gate output** (reason: `gate error`) — validated against the open-PR list to drop incidental mentions.
3. **`#NNNN` tokens in bot-review comment bodies** (reason: `bot comment`) — same validation.

### Priority boost for stuck blockers

If a PR has `stuckCycles >= 3` AND is listed as `blocked on` by ≥2 other PRs, it gets a `BLOCKING_STUCK_BONUS` (+50) on top of its issue-based score. This ensures a stuck baseline-bump PR that's holding up multiple siblings surfaces at the top of the queue, not buried behind individual CI-failure PRs.

Implementation: `rankPrsWithDeps()` in `crux/pr-patrol/scoring.ts`.

## Phase 3: Fix (one PR at a time)

Work through the queue starting with the highest-priority PR.

**IMPORTANT: Never `git checkout` PR branches in the current directory.** This causes branch confusion in multi-session slots. Use one of these isolation strategies:

**Option A (preferred): Use explicit branch isolation.**
For each PR fix, use an explicit `/tmp` worktree or a dedicated slot. Do not use subagent worktree isolation; it can corrupt the parent session's working directory.

**Option B: Use git worktrees manually.**
```bash
git worktree add /tmp/pr-fix-<N> <branch>
# ... make fixes in /tmp/pr-fix-<N> ...
cd /tmp/pr-fix-<N> && git push
git worktree remove /tmp/pr-fix-<N>
```

**Option C: For metadata-only fixes (PR body edits, labels), use `gh` CLI.**
These don't require checking out the branch at all.

### Merge conflicts
1. Spawn a subagent (worktree-isolated) or create a worktree for the PR branch
2. Rebase on main: `git rebase origin/main`
3. Resolve conflicts — prefer the PR's changes where intent is clear
4. For generated files (database.json, lock files), regenerate: `pnpm build-data:content`
5. `git rebase --continue` then `git push --force-with-lease`

### CI failures
1. Check what failed: `gh pr checks <N>`
2. Read CI logs to understand the failure
3. Spawn a subagent (worktree-isolated) to fix the issue, verify with `pnpm build` / `pnpm test`
4. Subagent commits and pushes

### Bot review comments (CodeRabbit etc.)
1. Bot comment details are included directly in the fix prompt (fetched via GraphQL `reviewThreads`)
2. For Major/Minor/Critical issues: verify the concern is valid, then fix (in a worktree-isolated subagent)
3. For Nitpick issues: fix only if trivial and clearly correct
4. Look for "Prompt for AI Agents" sections — they contain ready-made fix instructions

### Missing test plan
1. Read the PR diff to understand what changed
2. Add a `## Test plan` section to the PR body via `gh pr edit` (no checkout needed)

### Missing issue reference
1. Search for related issues: `gh issue list --search "keywords"`
2. If a match exists, add `Closes #N` to the PR body (no checkout needed)
3. If no match, skip — not all PRs need an issue

### Stale PRs
1. Rebase on main in a worktree to pick up latest changes
2. Push to re-trigger CI

## Phase 4: Report

After processing, summarize:
- How many PRs were scanned
- What issues were found and fixed
- What's still in the queue (if any)

## Guardrails

- **One PR at a time.** Finish one fix before starting the next.
- **Only fix detected issues.** Don't refactor or improve unrelated code on the PR's branch.
- **Use `--force-with-lease`** not `--force` when pushing rebased branches.
- **Don't dismiss reviews.** Fix the requested changes and let the reviewer re-approve.
- **If a conflict is too complex**, note it and move to the next PR.
- **Run `pnpm crux w validate gate --fix`** after any code changes.

## Daemon mode

For continuous monitoring, use the crux command:

```bash
pnpm crux gh pr-patrol                       # 5-min interval, continuous
pnpm crux gh pr-patrol once                  # Single pass
pnpm crux gh pr-patrol once --dry-run        # Preview only
pnpm crux gh pr-patrol --interval=120        # Custom interval
```
