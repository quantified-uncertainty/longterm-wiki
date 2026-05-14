# ADR-0003 internal-data scout — gate runtime, churn, baseline behavior

Snapshot date: 2026-05-03. Scope: 30 most recent CI workflow runs, 90/180-day git history of `crux/validate/`, gate help surface, internal dashboards inventory.

## Gate runtime — matches the user's stated pain

CI workflow ("CI" — the workflow that runs the gate) over the last 30 runs:

- **Average wall-clock: 12.9 min** (771s)
- **Median: 13.1 min** (786s)
- **p95: 20.2 min** (1214s)
- **Range: 1.8 min – 22.6 min**

The Charter framed gate runtime as "5–15 min pain"; the median is at the top of that range and p95 is well past it. Worth noting that wall-clock includes queue time, so true compute is somewhat lower, but as far as the human/agent waiting experience this is the number that matters. `--scope=content` advertises a 15s fast path vs ~5min, suggesting the maintainers already know the full gate is slow enough to need an opt-in for quick iteration.

## Reliability — concerning

Of 25 runs with terminal pass/fail outcomes (excluding 3 cancelled, 2 skipped):

- **Success rate: 56%** (14 success / 11 failure)

A gate that fails 44% of the time is either (a) catching a lot of real bugs, (b) flaky, or (c) being run on broken intermediate commits (push-and-iterate workflow). The Charter explicitly calls out one false-positive incident (QUA-755 "gate-baseline-drift"). This number alone doesn't disambiguate, but it does suggest "gate as fast feedback loop" is not the experience users get — they get "gate as slow flaky blocker."

## Code-churn — the system is still being actively built, not settled

Last 90 days in `crux/validate/`: **518 commits** touching the directory. Categorized:

- fix: 148 (29%)
- add: 116 (22%)
- refactor: 48 (9%)
- review (CodeRabbit / `/agent-review-pr` follow-ups): 39 (8%)
- delete: 8 (2%)
- merge: 84 (16%)
- other: 75 (14%)

**Add (116) outpaces delete (8) by ~14×.** The Charter cites 97 validator files; my `find` shows 130 top-level `.ts` files (138 incl. subdirs). The system is still in a "we keep adding validators" phase, not a "we maintain a stable set" phase. The 148 `fix:` commits are also non-trivial — each fix has a labor cost the validator must amortize against bugs it caught.

## Baseline-bump frequency — the canary the Charter worried about

180-day search for `baseline|bump|ratchet`: **47 commits**. Top examples include:

- "drop tsc baseline 71 → 27"
- "reduce tsc baseline 86→69"
- "regenerate sourcing lint baseline (round 2)" / "after recent merges" / "after rename PRs"
- "freeze baseline at 7 per QUA-296"
- "make sourcing ratchet advisory on non-main branches"

This is exactly the "validators bypassed instead of fixed" pattern the Charter listed as a cost. The same baseline is regenerated multiple times in succession ("round 2"), the sourcing ratchet has been weakened (advisory on non-main, then PR-only enforcement in QUA-820), and tsc baselines are tracked numerically — all signs that the rules are too noisy to enforce strictly and the response has been to relax them rather than fix them.

## Instrumentation present vs missing

`apps/web/src/app/internal/` has 32 dashboards, none of which appears to track gate or validator economics. Closest are `pr-dashboard`, `system-health`, `groundskeeper-runs`, `data-quality` — none captures per-validator runtime, per-validator pass/fail history, or "validators that have never caught a real bug." The gate help surface offers `--no-triage`, `--no-cache`, `--full-gate`, `--scope=content` but no `--profile` or `--verbose`. **There is no current way to answer "which validator costs the most?" or "which has caught zero bugs?" without reading the source.** This is a meta-finding for the ADR: the system the Charter wants to evaluate has no telemetry surface to evaluate it from, so the deletion-list answer will have to come from source reading + git-log spelunking, not measurement.

## Most surprising number

**47 baseline/ratchet commits in 180 days** — roughly one every 4 days. The Charter listed "ratchet drift incidents" as a cost; the data shows these aren't incidents, they're a cadence.
