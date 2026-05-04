# Codebase scout — validator inventory

Source data: `.claude/research-cache/0003-validator-economics/codebase.json` (machine-readable).

## Headline numbers

- **73 validator script files** in `crux/validate/` (the Charter says 97 — that figure included rule modules under `crux/lib/rules/` and the unified ruleset, which run as a single subprocess via `crux validate unified`).
- **66 of 73** are wired into the gate (`crux/validate/validate-gate.ts:226-944`), counting both direct subprocess invocations and the four indirected via `pnpm crux validate {schema,refs,unified,directory-pages}`.
- **1 in `validate-daily.ts`** that is not also in the gate (`validate-daily` itself, the runner).
- **1 in `validate-data.ts`** — `validate-data.ts` is its own runner exposed as `crux validate data`.
- **4 standalone-only** (CLI-registered but not in gate/daily): `validate-consistency`, `validate-financials`, `validate-hallucination-risk`, `validate-quality`.
- **1 unreferenced**: `validate-sourcing-names` — has a CLI-style header (`pnpm crux validate sourcing-names`) but is *not* registered in `crux/commands/validate.ts:13`. Truly orphaned.
- **Test coverage: 48/73 = 66%** sibling `.test.ts` files. There are 54 test files in `crux/validate/` total (including 4 in `__tests__/` and tests for `gate-triage`, `scope-flag`, `to-rdjsonl`, etc.).

## Dead / orphan candidates (5)

1. **`validate-sourcing-names`** (`crux/validate/validate-sourcing-names.ts:1`) — orphaned: not in gate, not in daily, not registered in `crux/commands/validate.ts`. Last meaningful change 2026-04-12. Header note in `validator-reclassification.md` says "sourcing-coverage was deleted (QUA-528) — check whether server-side enforceSourcing() also subsumes this." Strongest delete candidate.
2. **`validate-financials`** (`crux/validate/validate-financials.ts:1`) — standalone CLI only; last commit 2026-02-10 (~3 months ago). 376 LOC. Prior audit marks "informational".
3. **`validate-hallucination-risk`** (316 LOC) — standalone, informational report only. Last touched 2026-03-26.
4. **`validate-quality`** (340 LOC) — standalone, "advisory" content quality. Last touched 2026-04-19. Prior audit recommends "orchestrator" — could be folded into a single quality-check runner.
5. **`validate-consistency`** (649 LOC) — largest standalone, advisory cross-page consistency. Last touched 2026-03-21. Prior audit also marks "orchestrator".

## Top-5 most complex (LOC)

1. `validate-gate.ts` — 1,326 LOC (the runner; not a check itself, but a lot of orchestration logic with **no tests**).
2. `validate-soft-fks.ts` — 701 LOC (gate, advisory; has tests).
3. `validate-resource-quality.ts` — 652 LOC (gate, advisory; has tests).
4. `validate-consistency.ts` — 649 LOC (standalone-only candidate; **no tests**).
5. `validate-component-refs.ts` — 627 LOC (gate via `crux validate refs`; **no tests**).

Striking: **5 of the largest 7 validators have no test sibling**, including the gate itself.

## Top-5 most-recently-modified (signal of active maintenance)

- `validate-daily` (2026-05-02), `validate-table-states` (2026-05-02), `validate-entity-schema-drift` (2026-05-01), `validate-gate` (2026-05-01), `validate-no-bespoke-filter-chips` (2026-05-01).

The QUA-1006/1008/1009 frontend-pattern guards (`validate-table-formatting`, `validate-table-states`, `validate-no-bespoke-filter-chips`) all landed in the last 7 days — these are clearly active "regression-prevention" rules, not load-bearing data-integrity checks.

## Anything striking

- `validate-gate.ts` itself is 1,326 LOC of orchestration with no test sibling. It's the highest blast-radius file in the directory.
- The `validate-data.ts` "data integrity" check is invoked from `validate-daily.ts` but **NOT from the gate** — gate relies on the more granular successors (`temporal`, `cross-base`, `controlled-vocab`, `entity-refs`, `yaml-entity-refs`). Worth checking whether `validate-data.ts` overlaps fully or has unique coverage.
- Many gate steps are flagged `advisory: true` in `validate-gate.ts` (orphan-entities, soft-fks, resource-refs, resource-quality, scorecard-refs, etc.) — they run in CI but never block. That's a category to interrogate: advisory-forever validators are de facto demotion candidates.
