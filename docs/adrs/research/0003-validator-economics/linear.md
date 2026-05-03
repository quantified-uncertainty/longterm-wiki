# ADR-0003 — Linear evidence

Source-of-truth ticket list and per-ticket evidence is in `.claude/research-cache/0003-validator-economics/linear.json`. This document curates the strongest signal for the ADR write-up.

## Incident exemplars

**QUA-302 (Done, urgent)** — Migration 0173's `chk_hrs_level` CHECK constraint hit the 60s `lock_timeout` in PreSync, stalling the wiki-server deploy for 12+ hours and triggering a cascade of 7 symptom-management PRs. The parent QUA-156 was wrongly marked Done. **ADR lesson:** validators that *should* be schema-level (S-class CHECK constraints) carry production risk when added through migrations without enumerating row counts. The ADR's S-class disposition needs a clear playbook for "promote to schema CHECK *only after* enumeration + lock-safe migration."

**QUA-755 (Done, high)** — A fresh `origin/main` checkout failed local gate with 117 unified-validator errors, yet `gh run list` showed CI as green. Local-gate and CI-gate diverged because the pre-push hook trusted main as green and skipped failures. **ADR lesson:** the gate is not one system — it's a local set, a CI set, and a daily set, each carrying different validators. Any "delete vs keep" decision must specify which lane it belongs to. QUA-787 documents the same divergence pattern for `validate-factbase-record-refs` (CI never runs it; agents `--no-verify` past it).

**QUA-86 (Canceled, low)** — 23 of 50 PRs (46%) used `gate:rules-ok` to bypass the gate over a 30-day window; by 2026-04-12 the rate was still 32%, well above the 20% target. **ADR lesson:** override rate is the cheapest empirical signal that a validator is producing more friction than value. Any validator whose enforcement triggers an override more than ~25% of the time on the PRs it touches is a deletion candidate or needs reframing as advisory.

**QUA-761 (Done, high)** & **QUA-966 (Done, high)** — Two distinct silent-corruption bugs in validator `--fix`/`--update` paths. The entitylink-ids `--fix` swapped one person's name for another (Michael Kratsios → Melania Trump in a governance MDX) when wiki IDs got reassigned. validate-entity-schema-drift's `--update` corrupted the baseline and emitted phantom violations on comment lines. **ADR lesson:** every validator is also code with its own defect surface, and `--fix` modes are particularly dangerous because the diffs look plausible. The ADR principle for "when to add a validator" should require: no auto-fix unless the rule is type-safe-mechanical (e.g. removing whitespace), not slug-renaming.

**QUA-299 (Done, urgent)** — A meta-validator built specifically to detect when ratchet baseline files are bumped ≥3 times in 24h with monotonic direction. The trigger was the sourcing-ratchet being bumped 3+ times in 24h "as downstream agents silenced CI instead of questioning why main kept drifting." Direct empirical evidence for the baseline-bump anti-pattern. QUA-808 is a current open instance — `validate-sourcing-lint-guard` baseline frozen at 1, drifted to 4, every feature branch fails.

## Patterns

**Bumping vs fixing.** The Linear record shows baseline bumps are the dominant agent response when a ratchet validator blocks a PR. QUA-299 was built precisely because this happened ≥3 times in a single 24h window. QUA-808 is the inverse failure mode (a baseline that *can't* be lowered because the cleanup that would reset it is blocked on a deferred rename). Either way, ratchet baselines reach a steady state of "always slightly stale" and stop providing the regression-prevention they were designed for.

**Load-bearing vs false-positive-prone.** The clearest load-bearing signal is QUA-302 — a missing-validator failure (a CHECK constraint added without lock-safe enumeration) cost 12 hours of prod and 7 follow-up PRs. The clearest false-positive signals are QUA-86 (46% override rate), QUA-966 / QUA-761 (validators with their own bugs), and QUA-787 (CI doesn't even run it). The split is roughly: schema-level invariants are load-bearing; lint-style content invariants concentrate the false positives.

**Prior deletion proposals (predecessors to this ADR).** QUA-504 is the immediate predecessor — it proposed the S/W/R taxonomy and the 56→20 target. QUA-524 already shipped the deletion of 10 quick-win validators (redundant with git, actionlint, build system, etc.). QUA-525 migrated 6 S-class validators to PG CHECK constraints. QUA-528 migrated 7 W-class validators to /sync handler assertions but spawned 5 follow-up tickets (QUA-801–805) all still in Backlog. QUA-829 is an open delete-candidate (~280 LOC) for `validate-sourcing-lint-guard`. **The ADR can credibly extend QUA-504's framework rather than reinvent it** — and the open follow-ups (QUA-801–805, QUA-829, QUA-808) are the tail of work the ADR should sequence.

## Most damning incident

QUA-302 — 12 hours of prod outage and 7 cascading symptom-management PRs because a CHECK constraint that *should have been* enforced as an S-class schema migration was added without row-count enumeration; the parent ticket was prematurely marked Done. This is the single most concrete cost the ADR can cite for getting validator-vs-schema placement wrong.
