# ADR-0003: Validator economics

## Status

`Proposed` (dispatched 2026-05-03 from QUA-1085; red-teamed and revised 2026-05-03)

## Context

`crux/validate/` has **73 top-level validator files** (130 incl. subdirs — Charter's "97" used a different denominator; see `docs/adrs/research/0003-validator-economics/codebase.md`). 66 are wired into the gate. CI gate runtime: **median 13.1 min, p95 20.2 min** (last 30 runs). The reported **success rate of 56% is ambiguous** — conflates real-bug catches, flakes, and push-and-iterate WIP commits; suggestive of friction, not a clean signal. The system is in *growth*: 90-day `add:` (116) outpaces `delete:` (8) by ~14×, with 47 baseline-bump commits in 180 days (~one every 4 days). No `/internal/*` dashboard measures per-validator runtime or catch-rate.

Evidence from four scout reports: `docs/adrs/research/0003-validator-economics/{codebase,docs,internal-data,linear}.md`.

## Investigation

**Inventory.** 5 truly orphaned: `validate-sourcing-names` (unregistered), `validate-financials`, `validate-hallucination-risk`, `validate-quality`, `validate-consistency`. Test coverage 48/73 (66%) — but **5 of the 7 largest validators have no tests**, including `validate-gate.ts` itself (1,326 LOC of orchestration). Many gate steps are flagged `advisory: true` indefinitely.

**Existing taxonomy.** QUA-504 already proposed an S/W/R taxonomy (Schema/Wiki-content/Runtime classes) with a 56→20 target. QUA-524 deleted 10 quick-wins; QUA-525 migrated 6 S-class to PG CHECK; QUA-528 migrated 7 W-class to /sync handlers but spawned 5 stalled follow-ups (QUA-801–805). QUA-829 (delete `validate-sourcing-lint-guard`, ~280 LOC) is open.

**Failure modes concentrate by class.** Lint-style content invariants produce most false positives (QUA-755 local/CI divergence; QUA-787 CI doesn't run `validate-factbase-record-refs` at all). QUA-86 found a 46% gate-override rate before being Canceled — dated, weakest plank in the evidence chain. The clearest *missing*-validator cost is QUA-302: a CHECK constraint added without row-count enumeration cost 12h prod outage + 7 cascading PRs. Schema-level invariants pay for themselves; lint-level concentrate friction. **Validators also have their own bug surface** — QUA-761 (`entitylink-ids --fix` mis-renamed Kratsios→Trump) and QUA-966 (`validate-entity-schema-drift --update` corrupted its own baseline) are silent-corruption bugs in auto-fix paths.

**Bypass policy conflict.** `.claude/rules/proactive-github-filing.md:77` classifies "silencing a validator" as a symptom-patch red flag. Any deletion or demotion will trip that rule unless explicitly carved out.

## Options considered

1. **Status quo** — keep adding, occasional 1-off PRs (QUA-829 pattern). Doesn't address runtime, override rate, or 14× imbalance.
2. **QUA-504 S/W/R taxonomy + sequenced economics-driven deletion.** Tier each validator; delete W-class with override rate >25% or no catch in 180d; migrate S-class to PG CHECK; "delete-one-to-add-one" rule.
3. **Single-PR-series migration.** Move bulk of S/W-class to runtime invariants in one PR. Maximum LOC drop but high merge-conflict risk; QUA-528's 5 stalled follow-ups (QUA-801–805) shows bulk-PR loses migrators' attention.
4. **Telemetry-first.** Defer until per-validator dashboards exist. Adds work with no audience; existing data already justifies bottom-decile retirement.
5. **Scope-shard the gate.** Only run validators whose target glob intersects the diff (deterministic version of `gate-triage.ts`). Attacks runtime without deletion. Treats symptom (slow gate), not the systemic growth that ADR-0003 confronts.

## Decision

**Option 2.** Honestly: this is Option 3's migration work *sequenced* across phases instead of one PR. Compatible with Option 5, which can ship later as a runtime layer over the surviving validator set. We reject Option 3 only as a one-PR-series approach. Option 4 is rejected because existing data is already sufficient to retire the bottom decile. Option 5 is deferred to its own ADR.

**Migration plan:**

- **Phase 1 (1 week):** Carveout to `proactive-github-filing.md` (see "Carveout language" below). Add gate stage timing JSON output to `validate-gate.ts` (~30 LOC). **Exit:** carveout merged + baseline timing snapshot committed.
- **Phase 2 (1 week):** Delete the 5 orphans (~2,300 LOC). Ship QUA-829. Adopt "delete-one-to-add-one" rule. **Exit:** validator file count drops by ≥6; gate-stage timing shows ≥1 stage removed.
- **Phase 3 (3 weeks, not 2 — see realism note):** Tier-assign the remaining 67 validators using S/W/R + readily-available proxies *only*: gate-vs-advisory status, last-touch, last-bug-fix-commit, test-sibling presence. Override rate is NOT used at this phase — re-measuring requires Phase 1 telemetry to mature. File one ticket per W-class deletion candidate. **Exit:** every remaining validator has a documented S/W/R tier.
- **Phase 4 (1 week):** Resolve QUA-801–805 — close or complete each (close is permitted if the migration was wrong). Demote/delete any validator advisory-for-≥90d. **Exit:** 0 advisory-for-≥90d validators; QUA-801–805 all in Done or Canceled.

**Carveout language (binding for Phase 1):** the carveout permits deletion only when ALL of (a) override rate >25% over ≥10 PRs *since timing telemetry shipped*, OR no catch in 180d (per `git log`), OR not enforced in gate at all; AND (b) the validator is named in an ADR-0003 disposition list (not self-applied); AND (c) the validator is NOT one of the named ratchets (`sourcing-lint-guard`, `entity-schema-drift`, `typed-client`, `workflow-secrets`, `no-bespoke-filter-chips`, `tsc-baseline`).

**Coordination:** if ADR-0001 (crux package architecture) advances to Proposed during Phase 2-4, halt and re-sequence. **Stakeholder check before Phase 1 ships:** the ratchet authors (QUA-103/QUA-770/QUA-820/QUA-1009 owners) must sign off on the ratchet allowlist.

**Owner:** Coordinator & Agent Tooling; QUA-1085 tracks dispatch.

## Consequences

- **Positive:** smaller surface, faster gate, lower baseline-bump cadence, scoped deletion authority.
- **Negative:** risk that a low-catch-rate validator was load-bearing for a bug class that hadn't yet fired. Mitigation: git history preserves every validator.
- **Reversibility:** **High for non-ratchets** (one revert). **Low for ratchets** (named allowlist) — baseline frontier lost, incidents land in the gap. This is why the carveout excludes them.
- **Risks:** override-rate is noisy and not yet re-measured (pair with last-catch + last-touch + test-sibling); carveout could be self-applied if Phase 1 PR ships a general rule instead of the explicit named list.

## Follow-up tickets

- QUA-XXX (Phase 1) — Rule carveout + named exclusion list
- QUA-XXX (Phase 1) — Gate stage timing JSON
- QUA-XXX (Phase 2) — Delete 5 orphans + ship QUA-829
- QUA-XXX (Phase 2) — Delete-one-to-add-one rule
- QUA-XXX (Phase 3) — S/W/R disposition for 67 validators
- QUA-XXX (Phase 3) — Unstall QUA-801–805
- QUA-XXX (Phase 4) — Advisory-aging policy + scope-shard ADR charter (Option 5)

## References

- Linear: QUA-1085 (dispatch); QUA-504 (taxonomy); QUA-524/525/528 (shipped); QUA-829, QUA-808, QUA-801–805 (open tail)
- Incidents: QUA-302, QUA-755, QUA-86 (Canceled — number is dated), QUA-761, QUA-966, QUA-299
- Related ADRs: ADR-0001, ADR-0004
- Code: `crux/validate/validate-gate.ts:244` (`PARALLEL_STEPS`), `:226` (`UNIFIED_BLOCKING_RULES`), `.claude/rules/proactive-github-filing.md:77,80`
- Research: `docs/adrs/research/0003-validator-economics/{codebase,docs,internal-data,linear}.md`
