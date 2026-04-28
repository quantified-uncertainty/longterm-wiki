# ADR-0003: Validator economics

## Status

`Charter`

## Context

`crux/validate/` contains 97 validator files. The gate (`validate-gate.ts`) runs ~50+ of them on every PR; others run via `validate-data.ts`, `validate-daily.ts`, or are standalone. Each validator was added in response to a specific concern.

Costs of the validator system, observed and suspected:

- **Time**: gate run time per PR (current numbers TBD as part of this investigation)
- **Mental overhead**: agents and humans must understand which validators are blocking, which are advisory, what their messages mean
- **False positives**: occasional bad signals (e.g., the recent gate-baseline-drift QUA-755 incident)
- **Ratchet drift incidents**: baseline files that get bumped instead of fixed, defeating the validator's purpose
- **Maintenance**: each validator has its own bugs (the 2026-04-27 prior investigation flagged 8 validators not wired into gate/data/daily)

A prior 7-agent investigation (2026-04-27) found "8 validators not in gate/data/daily" but the deeper question — what each validator earns — was deferred to this ADR.

## Question

For each of the 97 validators in `crux/validate/`:

1. Is it currently catching real bugs (load-bearing)?
2. Is it overlapped by typecheck, tests, or runtime invariants (defense-in-depth)?
3. Was it useful one-time but now unnecessary (regression-prevention, can demote)?
4. Has it never caught anything (dead, can delete)?

And as a system-level question: should some validators move from CI gate to **runtime invariants** (DB CHECK constraints, Zod parsing) where they belong?

## What counts as a decision

A tiered list of validators with disposition specified:

- **Load-bearing** (keep, blocking)
- **Defense-in-depth** (keep, advisory or demote)
- **Regression-prevention** (keep one-pass; consider deletion after 6 months without violations)
- **Move to runtime invariant** (specify the new home)
- **Delete** (with confidence level)

Plus principles for adding future validators (when is a validator the right tool vs. a typecheck rule, vs. a runtime invariant).

## In scope

- Per-validator analysis: bugs caught (git log + PR commentary), gate stage time cost (telemetry), false positive rate (commits that touched the validator itself or added bypasses), counterfactual coverage by typecheck/tests
- Tier assignment for all 97 validators
- Identification of validator → runtime-invariant migrations
- Principles for future validator additions
- Recommended deletion list with LOC savings

## Out of scope

- Rewriting validators that stay
- The gate-triage LLM optimization itself (separate concern)
- Adding new validators (downstream)

## Time-box

5 working days from charter to decision.

## Success criteria

ADR ends with disposition-per-validator (97 entries) and a deletion PR target (e.g., "delete N validators saving M LOC and X seconds of gate time"). Even a "keep all 97" outcome is acceptable if defended with measurement.
