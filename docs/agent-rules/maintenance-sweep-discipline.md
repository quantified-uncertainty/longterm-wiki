# Maintenance Sweep Discipline

Read this before running a `/maintain` sweep (any cadence), before investigating a failing audit item, and before recording an audit result during a merge drought.

Per #4980, the entries below were re-derived from scratch by sweeps on 2026-05-25, 06-01, 06-17, 06-22, 07-27 and 07-31. They belong in `.claude/common-issues.md`, but **the sweep cannot write `.claude/*`** — see "The sweep cannot write its own prevention docs" below. This file is the writable home, written by the 2026-08-02 sweep.

## Check for an existing fix PR before investigating a failing audit

The `e2e-post-deploy-red-streak` audit has been failing continuously since 2026-05-24. Per #4980, six sweeps each re-derived the same root cause from scratch — pulling `--log-failed` for multiple multi-MB run logs, reading the spec, tracing components — and the fix had *already been written and pushed* in PR #4961 on 2026-06-22. The 2026-07-31 sweep independently reproduced an equivalent diff before discovering the PR existed.

This is a dominant consumer of sweep turn budget and a direct contributor to the recurring `Reached maximum number of turns` aborts (#4975).

**Prevention**: before investigating any failing audit or CI red streak, search for existing work *first*:

```bash
gh pr list -R quantified-uncertainty/longterm-wiki --state open --json number,title,files \
  --jq '.[]|"#\(.number) \(.title) :: \(.files|map(.path)|join(","))"'
gh issue list -R quantified-uncertainty/longterm-wiki --state open --search "<failing spec or workflow>"
```

If an open PR already touches the failing file, **do not re-derive the fix and do not open a competing PR** (`.claude/rules/agent-session-workflow.md` § CI-fix dedup). Verify the existing fix instead — running it against prod is far cheaper than rebuilding it, and a verification comment is what actually unblocks the merge.

## A frozen audit cannot self-clear — check whether the workflow even ran

`e2e-post-deploy.yml` triggers on CI completion on `production`. During a merge drought nothing deploys, so the audit stays pinned against a stale run window and re-investigating it can never change the verdict.

**Check the run history before spending any budget on the audit:**

```bash
gh run list -R quantified-uncertainty/longterm-wiki --workflow=e2e-post-deploy.yml --limit 8 \
  --json createdAt,conclusion --jq '.[]|"\(.createdAt|split("T")[0]) \(.conclusion)"'
```

As of 2026-08-02 the most recent run was 2026-06-20 — 43 days stale. Nothing a sweep does can move that verdict.

## Audit results can be vacuous passes — check the denominator

`gate-override-frequency` reports "0 overrides out of 0 merged PRs (0%)" during a merge drought and reads as a **pass**. It is measuring nothing. Several audits are unmeasurable while no code merges.

Before recording a pass, confirm the check had a non-zero denominator. Record the denominator in the note so a future sweep can tell a real pass from a vacuous one.

## Audit bookkeeping PRs conflict with each other

`crux sys audits check` writes `last_checked` / `last_result` / `history` into `.claude/audits.yaml`. Each sweep that records results opens a PR touching only that file, all measured against the same unchanged `main`. They read as `MERGEABLE`/`CLEAN` individually, but merging any one makes the rest conflict, and the conflicts are semantic (different results for the same audit ids on different dates) so they need hand resolution. Seven such PRs accumulated during the 2026-06/07 merge drought (#4974).

**During a merge drought, prefer read-only audit commands.** `crux sys audits run-auto`, `list`, and `report` do not write YAML; only `check` does. Report the results in the PR body or an issue comment instead of adding an eighth conflicting `audits.yaml` diff.

## GitHub Actions agents cannot commit changes to `.github/workflows/*`

Sessions running inside a GitHub Actions job authenticate with a GitHub App installation token, which is 403-blocked on workflow files — a workflow self-fix cannot land from inside the workflow. The same token writes non-workflow paths fine, so the failure is path-specific:

```
$ gh api -X PUT repos/.../contents/.github/workflows/scheduled-maintenance.yml --input payload.json
{"message":"Resource not accessible by integration","status":"403"}
```

The `permissions:` block in the workflow cannot grant this — the App itself needs `workflows: write`. `git push` of a branch carrying the change also never completes from the runner (two 120s timeouts, sandbox on and off).

**Prevention**: post the unified diff on the tracking issue and ask a human to apply it. **Never report a workflow change as shipped without confirming it on `main`** (`git ls-remote --heads origin '<branch>'` + grep the file at `origin/main`). The 2026-07-27 sweep wrote "Fixed in this sweep" into #4975 for a change that never landed, and the same bug recurred two days later (#4979).

## The sweep cannot write its own prevention docs

The Claude Code harness classifies `.claude/*` as sensitive and refuses Edit/Write there, so a sweep instructed to "add recurring issues to `.claude/common-issues.md`" cannot comply. This is a **different mechanism** from the workflow 403 above (that is the GitHub App token; this is the local edit tool), but the same class: *the sweep is instructed to maintain files it cannot write*.

Sweeps on 2026-07-30 and 07-31 filed #4979 and #4980 with ready-to-paste content and stopped there. Nothing landed, so the 08-02 sweep hit the identical block. Filing a third issue with the same body would be pure waste.

**Prevention**: write prevention knowledge to `docs/agent-rules/` (writable) and add a row to the Tier 2 table in `CLAUDE.md` (also writable) so it stays discoverable. Reserve `.claude/common-issues.md` patches for a human to apply. Do not file another issue whose sole content is a patch that two open issues already carry — comment on those instead.

### Use the CLI, not the edit tool, to check off the checklist

`.claude/wip-checklist.md` is under the same block, so the agent's Edit tool **cannot** tick items — and the `.githooks/pre-push` hook refuses the push while items are open:

```
✗ 9 blocking items unchecked. Run /agent-ship before pushing.
  To bypass: git push --no-verify
```

Do **not** reach for `--no-verify`. `crux sys agent-checklist` runs as a subprocess and is not subject to the edit-tool block, so it can still write the file:

```bash
pnpm crux sys agent-checklist check duplicate-check scope-complete security
pnpm crux sys agent-checklist check --na tests-written --reason "markdown-only change"
```

`.claude/rules/agent-session-workflow.md` tells you to edit the file directly ("change `[ ]` to `[x]`"), which is correct for normal sessions but impossible under this block. The CLI path works in both cases — prefer it unconditionally.

## See also

- `.claude/commands/maintain.md` — the sweep workflow itself
- `docs/agent-rules/e2e-locator-scoping.md` — the Playwright trap that consumed six sweeps
- `docs/agent-rules/patrol-health-gate.md` — the fleet-level "stop patching symptoms" rule
- #4974 (merge drought / conflict cascade), #4975 (max-turns recurrence), #4979 (workflow 403), #4980 (`.claude/*` write block)
