# Improve Pipeline Benchmark Gate

Read this before changing any of:

- `crux/lib/research/**`
- `crux/commands/research-improve-entity.ts`
- `crux/commands/research-improve-entity-suite.ts`
- `crux/commands/research-benchmark.ts`
- `crux/commands/research-benchmark-suite.ts`
- `crux/lib/search/research-agent.ts`
- `crux/lib/job-handlers/claim-sourcing.ts`
- `crux/benchmarks/entity-suite.yaml`

## What it is

A CI gate (QUA-871) that runs the closed-loop improve-entity suite on PRs that touch the pipeline files above, and fails the check if median(coverage_score) drops by more than 0.05 OR median(verified_rate) drops by more than 5pts vs the latest `main` baseline.

Two workflows:

| File | Purpose |
|---|---|
| `.github/workflows/improve-pipeline-baseline.yml` | Nightly cron at 07:00 UTC. Runs `crux tb improve-entity-suite --tag=main-latest` and `crux tb benchmark-suite --tag=main-latest` against `main`, uploads both snapshots as the `improve-pipeline-baseline-main-latest` artifact. |
| `.github/workflows/improve-pipeline-benchmark.yml` | PR gate. Triggered on the path filter above. Downloads the latest baseline artifact, runs the suite tagged `pr-<num>`, runs `crux tb pipeline-regression-check`, posts/updates a PR comment, fails on regression. |

The decision logic lives in `crux/commands/research-pipeline-regression-check.ts` so it can be unit-tested without CI YAML.

## Override mechanism

When a regression is intentional — e.g., a stricter pre-filter that drops verified-rate but raises quality, or a deliberate benchmark recalibration — add this comment to the PR description:

```html
<!-- benchmark-skip: short reason here -->
```

The gate still runs the suite and posts the diff comment. The `Override` section of the comment names the reason. The check exits 0 (PR not blocked), but the regression remains visible in the PR record.

The marker:

- Must be a single-line HTML comment (the parser does not match across newlines).
- Reason must be non-empty after trimming whitespace.
- Keyword is case-insensitive (`benchmark-skip`, `BENCHMARK-SKIP`).
- Only the first match is honored.

When **not** to use it: a real, unintended regression. Override is for "I know this drops the metric and I have a reason"; it is not "the suite is flaky, override and move on." If you suspect flakiness, file a Linear ticket — multiple back-to-back overrides without ticketed cause is a red flag per `.claude/rules/proactive-github-filing.md` § "Mandatory tracking — red flags".

## Cost & runtime

- **Per PR run**: ≤$5 LLM spend, ≤8 min wall-clock, capped by `--budget=5` on the suite.
- **Per cron run**: same cap, runs once daily.
- **No-op pipeline change** (e.g., a comment-only edit in a triggered file): typically ~$0.30–$0.50 because most entities converge in iteration 1 with cached sourcing.

`$5` is the ticket's explicit budget cap and is **lower** than the suite's natural default of `$2 × N supported entities` (QUA-1033 — `$16` for the current 8-entity suite). The implied per-entity cap is `$5 / 8 = $0.625`, sufficient for the typical $0.04 policy run with retry headroom but tight if multiple entities need extended sourcing. If the gate starts seeing chronic `entities_skipped_budget > 0` on no-op PRs, raise the workflow budget rather than relaxing the threshold.

## Security & trust model

Both workflows are `pull_request`-triggered (not `pull_request_target`), run against the PR head SHA, and are passed `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, and `LONGTERMWIKI_SERVER_API_KEY`. That means anyone who can push to a branch in this repo and craft a PR that touches one of the triggered paths can run arbitrary code with those secrets in scope.

- **Fork PRs are blocked** by `if: github.event.pull_request.head.repo.full_name == github.repository`. Fork pushers don't get the secrets and the gate doesn't run for them — a maintainer who wants the gate to fire on a fork's diff has to branch the change into the canonical repo first.
- **Same-repo pushers are trusted**, transitively, because anyone with push access to the canonical repo already has indirect access to the secrets via repository settings, Actions logs from existing scheduled workflows, and the deploy pipeline. The gate doesn't widen the trust boundary; it just runs on a trigger that other CI jobs already use the same way (cf. `linear-verify-pr.yml`).
- A future hardening step would be to split the gate into a `pull_request` artifact-producing job (no secrets) plus a `workflow_run`-triggered comparison job (secrets, against `main`). That isolation is heavier than v1 needs but worth filing if the threat model changes.

## Baseline persistence

Baseline snapshots live as GitHub Actions artifacts (`actions/upload-artifact@v4`, 30-day retention) on the cron workflow's runs. The PR gate uses `actions/github-script` to find the latest successful baseline run, then `actions/download-artifact@v4` with `run-id` for cross-workflow download.

If no baseline has ever succeeded (e.g., the cron is broken or has never run), the gate runs in **advisory mode** — posts a comment noting the missing baseline, exits 0. Don't treat advisory as "no regression"; it just means the data isn't there to compare.

## Wiki-server interaction

Both workflows run with `WIKI_SERVER_ENV=prod`. The suite calls prod for claim sourcing — same posture as `flagship-curate.yml` and `sourcing.yml`. The mutated YAML in CI's working tree is throwaway (artifacts go to /tmp; the working tree is never committed back).

**Concurrent-run risk**: improve-entity-suite has a single-instance mutex on `pipeline_runs` (QUA-1032). If a PR run starts while the cron is already in flight (rare — both windows are ≤8 min, cron runs daily), the PR's suite call exits 2 and the gate fails. Re-running the workflow once the cron finishes resolves this. A future iteration could add automatic retry.

## When to update the entity-suite YAML

`crux/benchmarks/entity-suite.yaml` is itself a triggered path. Any edit triggers the gate. If you add an entity, expect a baseline run that includes the new entity to be published before the next PR can pass — until then, the new entity is in the candidate snapshot but not the baseline. The diff handles this: the entity appears as `_new_` in the per-entity table, and aggregate medians may shift. If the shift exceeds threshold, document why in the PR with a `benchmark-skip` and let the next baseline cron stabilize.

## Testing changes to the gate itself

```bash
# Unit tests for the decision logic
pnpm exec vitest run crux/commands/research-pipeline-regression-check.test.ts

# Lint the workflow YAML by parsing locally
node -e 'console.log(require("yaml").parse(require("fs").readFileSync(".github/workflows/improve-pipeline-benchmark.yml", "utf8")))'

# Hand-run the regression check against fixture snapshots
pnpm crux tb pipeline-regression-check \
  --baseline-coverage=/path/to/main-bench.json \
  --baseline-improve=/path/to/main-improve.json \
  --candidate-coverage=/path/to/pr-bench.json \
  --candidate-improve=/path/to/pr-improve.json \
  --pr-body-file=/path/to/pr-body.txt
```

## Related

- QUA-873 — `benchmark-suite` (read-only state metric) prerequisite
- QUA-882 — `improve-entity-suite` (closed-loop runner) prerequisite
- QUA-883 — Epic: Defensive content pipeline (parent)
- QUA-1032 — single-instance mutex on `pipeline_runs`
- QUA-1033 — default budget = $2 × N supported entities
