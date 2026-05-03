# ADR-0003: Validator economics

## Status

`Proposed` (dispatched 2026-05-03 from QUA-1085; awaiting red-team)

## Context

`crux/validate/` has **73 top-level validator files** (130 incl. subdirectories — the Charter's "97" used a different denominator, see `docs/adrs/research/0003-validator-economics/codebase.md`). 66 are wired into the gate. Median CI gate runtime is **13.1 min, p95 20.2 min, success rate 56%** (last 30 runs). The system is still in a *growth* phase: in the last 90 days, `add:` commits (116) outpace `delete:` (8) by ~14×, with 47 baseline-bump commits in 180 days — roughly one every 4 days. None of the 32 `/internal/*` dashboards measure per-validator runtime or catch-rate.

Three scout reports compile the evidence: `docs/adrs/research/0003-validator-economics/{codebase,docs,internal-data,linear}.md`.

## Investigation

**Validator inventory.** 5 truly orphaned: `validate-sourcing-names` (unregistered), `validate-financials`, `validate-hallucination-risk`, `validate-quality`, `validate-consistency`. Test coverage 48/73 (66%) — but **5 of the 7 largest validators have no tests**, including `validate-gate.ts` itself (1,326 LOC of orchestration). Many gate steps are flagged `advisory: true` indefinitely — running on every PR without ever blocking.

**Existing taxonomy already exists.** QUA-504 proposed an S/W/R taxonomy (Schema-class / Wiki-content-class / Runtime-class) with a 56→20 target. QUA-524 already deleted 10 quick-win validators. QUA-525 migrated 6 S-class to PG CHECK constraints. QUA-528 migrated 7 W-class to /sync handler assertions but spawned 5 follow-up tickets (QUA-801–805) all stalled in Backlog. QUA-829 (delete `validate-sourcing-lint-guard`, ~280 LOC) is open.

**Failure modes concentrate by class.** Lint-style content invariants produce most false positives (QUA-86: 46% override rate; QUA-755: local/CI divergence; QUA-787: CI doesn't run `validate-factbase-record-refs` at all). The clearest *missing*-validator cost is QUA-302 — a CHECK constraint added through a migration without row-count enumeration: 12 hours of prod outage, 7 cascading PRs. Schema-level invariants pay for themselves; lint-level concentrate friction.

**Validators have their own bug surface.** QUA-761 (`entitylink-ids --fix` swapped Michael Kratsios → Melania Trump in a governance MDX) and QUA-966 (`validate-entity-schema-drift --update` corrupted its own baseline) are silent-corruption bugs in auto-fix paths.

**Bypass policy conflict.** `.claude/rules/proactive-github-filing.md:77` classifies "silencing a validator" as a symptom-patch red flag. Any deletion or demotion will trip that rule unless explicitly carved out.

## Options considered

1. **Status quo** — keep adding, occasionally delete via 1-off PRs (QUA-829 pattern). Predictable but doesn't address gate runtime, override rate, or the 14× add-vs-delete imbalance.
2. **Adopt QUA-504's S/W/R taxonomy as the formal disposition framework + economics-driven deletion.** Tier each validator by class and cost; delete W-class validators with override rate >25% or no catch in 180 days; migrate S-class to PG CHECK; freeze the validator total at 73 with a "delete-one-to-add-one" rule until proven otherwise.
3. **Aggressive runtime-invariant migration** — move the bulk of S-class and W-class validators to PG CHECK / Zod / /sync handler assertions in one PR series. Maximum LOC reduction but high migration risk and stalls behind the 5 already-stuck QUA-801–805 follow-ups.
4. **Telemetry-first** — defer all deletion until per-validator runtime + catch-rate dashboards exist. Honest but adds dashboard work that has no audience and delays gains the data already justifies.

## Decision

**Option 2 (extend QUA-504's taxonomy + economics).** Plus the cheapest piece of telemetry needed to make the framework self-sustaining (gate timing per stage, no per-validator catch-rate dashboard).

We will not adopt Option 3 because the QUA-801–805 stall demonstrates that bulk migrations create stalled follow-up tails. We will not adopt Option 4 because the existing data (override rate, baseline-bump cadence, success rate, age) is already sufficient to retire the bottom decile.

**Migration plan:**

- **Phase 1 (1 week):** Carve "deletion of an unenforced or override-heavy validator with ADR-0003 disposition" out of `proactive-github-filing.md` § "symptom-patch red flag". Without this, the rest is blocked. Add gate stage timing JSON output to `validate-gate.ts` (~30 LOC); commit a snapshot to `docs/adrs/research/0003-validator-economics/timings.json` for baseline.
- **Phase 2 (1 week):** Delete the 5 orphans (~2,300 LOC). Resurrect QUA-829 and ship it. Adopt "delete-one-to-add-one" rule in `.claude/rules/implementation-quality.md` § "Codebase-wide sweeps".
- **Phase 3 (2 weeks):** Tier-assign the remaining 68 validators using the S/W/R framework + (override rate, last catch, last touch). File one ticket per W-class deletion candidate. Unstall QUA-801–805 by either completing or explicitly cancelling each.
- **Phase 4 (1 week):** Demote any validator advisory-for-≥90-days that has not been promoted; either move it to runtime invariant or delete it. Advisory-forever is a smell.

**Owner:** Coordinator & Agent Tooling (this ADR); QUA-1085 tracks dispatch.

## Consequences

- **Positive:** smaller surface; faster gate; lower baseline-bump cadence; clear deletion authority.
- **Negative:** non-zero risk that a "low catch rate" validator was load-bearing for a bug class that simply didn't fire in the measurement window. Mitigation: git history preserves every validator; revert is ~10 min.
- **Risks:** (a) override-rate is noisy — pair with last-catch + last-touch. (b) Phase 1 carveout could be misused — limit to validators with an ADR-0003 disposition.
- **Reversibility:** High. Each deletion is one revert. Borderline cases can downgrade to advisory instead of delete.

## Follow-up tickets

- QUA-XXX (Phase 1) — Rule carveout: "deletion vs silencing" amendment to `proactive-github-filing.md`
- QUA-XXX (Phase 1) — Add gate stage timing JSON to `validate-gate.ts`
- QUA-XXX (Phase 2) — Delete 5 orphan validators (~2,300 LOC) + ship QUA-829
- QUA-XXX (Phase 2) — Adopt delete-one-to-add-one rule
- QUA-XXX (Phase 3) — S/W/R disposition for remaining 68 validators (one parent + N children)
- QUA-XXX (Phase 3) — Unstall QUA-801, QUA-802, QUA-803, QUA-804, QUA-805 (close or complete each)
- QUA-XXX (Phase 4) — Advisory-aging policy: demote/delete validators advisory >90d

## References

- Linear: QUA-1085 (this dispatch); QUA-504 (taxonomy predecessor); QUA-524, QUA-525, QUA-528 (prior phases shipped); QUA-829, QUA-808, QUA-801–805 (open tail)
- Incidents: QUA-302 (12-hour deploy stuck), QUA-755 (local/CI divergence), QUA-86 (46% override rate), QUA-761 / QUA-966 (validator --fix silent corruption), QUA-299 (baseline-bump-detector meta-validator)
- Related ADRs: ADR-0001 (crux package architecture, may absorb this if `crux/validate/` becomes its own workspace package), ADR-0004 (agent workflow ROI, overlaps on rule audit)
- Code: `crux/validate/validate-gate.ts:226-944` (gate parallelChecks), `.claude/rules/proactive-github-filing.md:77,80` (silencing rule)
- Research: `docs/adrs/research/0003-validator-economics/{codebase,docs,internal-data,linear}.md`
