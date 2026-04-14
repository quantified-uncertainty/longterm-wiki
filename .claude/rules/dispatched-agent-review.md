# Dispatched Agent Review — MANDATORY

When a coordinator session dispatches subagents to work on issues and create PRs, **every dispatch prompt MUST instruct the agent to run `/agent-review-pr` before creating the PR**. Do not instruct subagents to run `pnpm crux gh pr create` directly.

Dispatchers also have their own pre-flight responsibilities — see the **Dispatcher pre-flight** section below. This rule covers both sides of the dispatch: the coordinator (dispatcher) and the slot agent (dispatched).

## Dispatcher pre-flight — MANDATORY

Before writing a dispatch brief for any Linear-tracked ticket, the coordinator MUST run all three of the following checks and confirm no existing claim is in flight:

1. **Linear state** — Run `pnpm crux linear view QUA-NNN`. Confirm the issue is **not already In Progress with a recent (<24h) start comment from a different session**. Recent start comments mean a slot already picked this up.
2. **Open PRs** — Run `gh pr list -R quantified-uncertainty/longterm-wiki --search "QUA-NNN in:body" --state all --json number,state,headRefName`. Confirm **no open PR references the ticket**. A closed-unmerged PR is usually fine (investigate the close reason); an open PR almost always means another session is iterating on it.
3. **Active slots** — Run `./ws list` (or `pnpm crux sys sessions list` once QUA-413 ships). Confirm **no other slot is currently on a `claude/qua-NNN-*` branch** or has an uncommitted working tree that suggests it's on the same ticket.

**If any check surfaces an existing claim, abort the dispatch.** Either (a) investigate the existing session first and confirm it's abandoned/stuck before taking over with `--force`, or (b) comment on the existing PR instead of opening a new one, or (c) wait for the in-flight session to ship.

### Why this rule exists — QUA-406 / QUA-397

On 2026-04-13, the coordinator filed QUA-397, the user started a slot a9 session on it and shipped PR #4296, and then the **same coordinator session dispatched slot a16 to fix the same bugs 3 hours later** without running any of the three checks above. The result: two competing PRs, ~$100+ of wasted compute, and PR #4297 had to be closed.

This wasn't a tooling gap — the tooling fixes in QUA-406 (PR #4300) and QUA-440 (PR #4307) closed the server-side holes. This is the **coordinator-side** gap: a dispatcher with all the information to prevent duplication still dispatched anyway. A rule catches behavior under context pressure in a way that code checks can't.

### Preferred enforcement — `crux sys dispatch`

Once QUA-437 ships, `pnpm crux sys dispatch --linear=QUA-NNN --slot=N` will enforce all three pre-flight checks structurally and refuse on collision. **That wrapper is the preferred way to dispatch going forward** — it makes the rule unskippable under context pressure.

Hand-dispatch via `./ws open <N> --claude` + a hand-written brief is permitted only when the wrapper is unavailable, and in that case the coordinator is **personally** responsible for running all three checks before writing the brief.

### Escape hatch — `--force` with explicit reason

For genuine emergencies (prod-down incident response, explicit hotfix authorization from the user), a coordinator may bypass the pre-flight with `--force`. Every `--force` dispatch MUST:

1. Post a comment on the existing Linear issue explaining why the claim is being taken over.
2. Explicitly state in the dispatch brief: `⚠ Forced past dispatcher pre-flight — reason: <reason>`.
3. Reconcile with the prior session afterward (close the prior PR, coordinate the branch handoff, or document the abandonment in Linear).

`--force` is NOT a way to dispatch faster — it's a way to override the check when the rule's purpose (preventing duplicate work) is already satisfied by out-of-band coordination.

### Scope — what this rule does NOT cover

- **Non-dispatch work.** If the coordinator is doing the work itself (editing in `coord/` or its own slot), `crux linear start` dedup handles it. This rule is only for dispatching to a slot.
- **Research / exploration dispatches with no Linear ticket.** If there's no ticket, there's nothing to dedup. The rule only fires when `--linear=QUA-NNN` is present on the dispatch.
- **Dispatches to an existing in-flight session on the same ticket** (e.g., the coordinator is adding follow-up instructions to a slot that's already working the ticket). In this case the slot is not a new claimant; skip the pre-flight but note the context in the brief.

### Compliant dispatch brief — template

Use this as the header of every hand-written dispatch brief (typically saved under `lw/dispatch/qua-NNN.md` in the workspace repo). The three checkboxes must be ticked before the brief is handed off to a slot — an unticked box means the brief is incomplete and MUST NOT be used.

```markdown
# Dispatch: QUA-NNN — <short description>

**Linear:** https://linear.app/quantifieduncertainty/issue/QUA-NNN (P?)
**Slot:** a??
**Branch to create:** `claude/qua-nnn-<short-description>`
**Dispatched by:** <coordinator session identifier, e.g. "slot-orchestration 2026-04-14">

## Dispatcher pre-flight — verified before this brief was written

- [ ] **Linear state** — `pnpm crux linear view QUA-NNN` shows no recent cross-slot claim
- [ ] **Open PRs** — `gh pr list -R quantified-uncertainty/longterm-wiki --search "QUA-NNN in:body" --state all` returns no open PR
- [ ] **Active slots** — `./ws list` shows no other slot on `claude/qua-nnn-*`

(If this is a --force dispatch: replace the three boxes with `⚠ Forced past pre-flight — reason: <reason>` and post a reconciliation note on the Linear issue.)

## What you're fixing

<One-paragraph framing, linking to the Linear issue body for details.>

## Ship checklist — MANDATORY

Before creating the PR: run `/agent-review-pr`.
Creating the PR: use `/agent-ship`, not raw `pnpm crux gh pr create`.
```

A file at `lw/dispatch/TEMPLATE.md` in the workspace repo containing this template is a nice-to-have but not required by this rule — the template lives here, canonically, inside the rule itself, so it's always loaded into every coordinator session automatically.

## Why

The existing `/agent-ship` workflow has `/agent-review-pr` as a mandatory, non-skippable Step 2b. But when a coordinator dispatches subagents with prompts like "do the work, run `pnpm build`, run `pnpm crux gh pr create`", the subagents bypass the entire `/agent-ship` flow and skip the review step.

Session on 2026-04-11: 15 PRs dispatched across 2 waves with "skip-the-ship-flow" prompts. All 15 passed build+tests. Retrospective review found **8 real issues (~53% hit rate)**, including:
- 2 deploy-blockers (CHECK constraints missing enum values, silent sync failure)
- 1 critical correctness bug (validation ran after transaction commit)
- 1 budget double-subtraction
- 1 partial sweep (missed a 3rd entry point for the same check)
- 1 cross-service deploy-order bug
- 1 false claim of "simplification" that was never actually committed

The review step exists. It works. Dispatched agents just weren't reaching it.

## How to apply

### For coordinators dispatching subagents

Every dispatch prompt ending in "create a PR" must include this phrase:

```
### Before creating the PR:
Run `/agent-review-pr` on your changes — it's adaptive and scales to PR size. Address every finding before proceeding to PR creation.

### Creating the PR:
Use `/agent-ship` (not raw `pnpm crux gh pr create`). This runs the full ship workflow including the mandatory review step, deploy task detection, Linear updates, and session logging.
```

### For the coordinator after dispatch

When a dispatched agent reports completion, verify:
1. `gh pr view <N>` — PR exists
2. `gh pr view <N> --json body --jq '.body' | grep -i "review"` — review was mentioned in PR body (optional heuristic)
3. Read the agent's report for the phrase "ran `/agent-review-pr`" or "ran `/agent-ship`"

If an agent reports creating a PR without mentioning the review step, **run `/agent-review-pr` on the PR yourself before considering it shipped**.

### Never trust claims without verification

If an agent claims to have simplified code, fixed bugs, or applied review findings:
- `git log --oneline <branch> -5` — confirm commits exist
- `git show --stat <commit>` — confirm the claim matches the diff
- `gh pr diff <N>` — confirm the remote state

See `.claude/memory/feedback_verify_agent_claims.md` for the pattern.

### Subagent permission limitation (mitigated)

Claude Code has a known regression (v2.1.56+) where subagents do not inherit
the parent's `permissions.allow` list — see
[#18950](https://github.com/anthropics/claude-code/issues/18950),
[#37730](https://github.com/anthropics/claude-code/issues/37730),
[#28584](https://github.com/anthropics/claude-code/issues/28584). Without a
workaround, Edit/Write on `.claude/commands/*`, `.claude/agents/*`, and
`.claude/skills/*` silently fails in dispatched subagents.

**Mitigation in this repo**: `.claude/hooks/approve-claude-configs.sh` is a
PreToolUse hook that auto-approves Edit/Write on those three paths. Hooks
fire for subagents (unlike `permissions.allow`), so this restores the
expected behavior. The hook is narrowly scoped to those paths only.

## Anti-patterns to avoid

**Bad dispatch prompt:**
```
Do the work. Run `pnpm build` and `pnpm test`. Then push and run `pnpm crux gh pr create`.
```

**Good dispatch prompt:**
```
Do the work. Run `pnpm build` and `pnpm test`. Then run `/agent-review-pr` on your changes. Address every finding. Then run `/agent-ship` to push, verify CI, and close the session.
```

The difference: 1 extra line, 50%+ bug rate reduction.
