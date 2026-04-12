# PR Patrol — Health Gate (QUA-297)

The patrol loop checks **fleet-level health** before doing any per-PR work. When prod is stuck or main CI is red across multiple commits or a ratchet is being bumped repeatedly, the patrol **halts PR fixing** and escalates — instead of churning out symptom-patches.

## The rule

**If you're writing code to silence a CI signal, stop. Check main health first.**

Specifically, when the health gate trips, do NOT:

- Bump a baseline file to get CI green
- Revert a rename because endpoints are 404ing
- Add `it.skip()` to a failing test without an issue number
- Merge a "fix the fix" PR into a pipeline that's already broken
- Dispatch an agent to work on the Nth PR in a cascade

Instead: **root-cause the fleet-level signal the gate flagged.** The escalation message names the exact subsystem (deploy pipeline, main CI, ratchet drift) and points at the prescriptive fix pattern.

## Why this exists

The 2026-04-11→12 retrospective: wiki-server deploy was stuck on migration 0173 for ~12h. Deploy #4167 failed PreSync at 22:57 UTC. Deploy #4180 failed the same way. Meanwhile, 7+ PRs silenced downstream symptoms (baseline bumps, route-axis pause, client reverts, re-migrate attempts, misdiagnosed "alias" issues). No agent asked "why does main keep drifting in this subsystem?"

Per-PR detectors don't catch this pattern. The signal is fleet-level:

- "Last 2 production deploys both failed" (deploy-stuck, score 200)
- "Main CI has been red across 3 consecutive commits" (main-ci-red, score 180)
- "The same baseline file has been bumped 3× in 24h in the same direction" (ratchet-drift, score 150)

All three outrank every per-PR issue (conflict=100, stuck=85, ci-failure=80, …) so they surface before patrol dispatches a wasteful fix.

## How the gate works

At the start of every patrol cycle, `runHealthGate()` calls `healthScan()`:

```
cycle start
  ├── HEALTH GATE
  │    ├── healthScan()   (deploy + main CI + ratchet drift)
  │    ├── if unhealthy:
  │    │    ├── emit JSONL event  (coordinator reads this)
  │    │    ├── log red warning   (human visibility)
  │    │    ├── return early      (skip PR work this cycle)
  │    └── else: proceed
  ├── 0a. Check tracked main-fix PR
  ├── 0b. Check main branch CI (per-PR signal, not fleet)
  ├── 1. Fetch PRs → detect → rank → fix
  └── ...
```

Per-fingerprint cooldown (30min) prevents spam when an underlying issue takes hours to resolve. The same "deploy-stuck" signal is re-emitted at most once per 30min, but the patrol still halts PR work on every cycle that sees unhealthy state — the cooldown only affects whether we write another escalation line, not whether we keep touching PRs.

## When the gate misbehaves

`PATROL_DISABLE_HEALTH_GATE=1` bypasses the gate entirely. Use this only when the gate itself is broken and needs debugging — NOT when prod is red and you want the patrol to "keep working anyway."

The patrol logs loudly when the bypass is engaged. If you see the bypass warning in the logs, treat it as a P0 incident: someone (or some process) is explicitly suppressing the safety check.

## For agents writing PRs

If you're mid-way through a PR and notice:

- The same baseline you're about to bump was bumped yesterday too
- A rename you're about to revert was reverted last week
- A test you're about to skip was skipped 3 times before

**Stop.** File a Linear ticket describing the pattern and escalate to the coordinator. This is exactly what the 2026-04-11 cascade looked like in its second PR; everyone who continued past that signal spent effort on a problem that wasn't the real one.

## Troubleshooting

**Gate seems stuck "green" while prod is red.** Check the scan-error counter:

```bash
cat ~/.cache/pr-patrol/state/health-gate-cooldown.json | jq '.["__scan_error_count__"]'
```

If ≥ 3, the scanner has been failing for multiple cycles and the gate has flipped to halt. Inspect recent `health_scan_error` entries in `~/.cache/pr-patrol/runs.jsonl`.

**Gate keeps returning `proceed: false` after you think the issue is fixed.** The cooldown file only rate-limits escalation emission — it does *not* control whether `runHealthGate()` trips. If the scanners still report unhealthy, the gate will still halt regardless of cooldown state. Inspect the scanners directly:

```bash
# See exactly which scanner is unhealthy and why:
pnpm crux gh pr-patrol health-scan

# Drill into the signals:
pnpm crux gh pr-patrol health-scan --deploy    # deploy-stuck
pnpm crux gh pr-patrol health-scan --ci        # main-ci-red
pnpm crux gh pr-patrol health-scan --ratchet   # ratchet-drift
```

If a scanner is still flagging, fix the underlying condition (unstick the deploy, unbreak main CI, revert a bad ratchet bump). Only clear the cooldown file to reset *escalation rate-limiting* (e.g., to force a fresh JSONL `health_gate_tripped` event once you've fixed the issue):

```bash
# Reset escalation rate-limit only (does NOT stop the gate from tripping):
rm ~/.cache/pr-patrol/state/health-gate-cooldown.json
# Or reset one fingerprint:
jq 'del(.["deploy-stuck"])' ~/.cache/pr-patrol/state/health-gate-cooldown.json | sponge ~/.cache/pr-patrol/state/health-gate-cooldown.json
```

**Reading escalation events**:

```bash
# Most recent gate trips:
jq -c 'select(.type == "health_gate_tripped")' ~/.cache/pr-patrol/runs.jsonl | tail -10

# Scan errors:
jq -c 'select(.type == "health_scan_error")' ~/.cache/pr-patrol/runs.jsonl | tail -10
```

## See also

- `.claude/rules/proactive-github-filing.md` § "Mandatory tracking — red flags"
- QUA-297 — Health-Gate Patrol parent issue + retrospective
- `crux/pr-patrol/health-scan.ts` — the scanners
- `crux/pr-patrol/health-gate.ts` — the gate wiring
