# ADR-0003 Phase 3 — Validator S/W/R disposition

**Scope:** the 67 validators in `crux/validate/` after Phase 2's 5 orphan deletions (`validate-sourcing-names`, `validate-financials`, `validate-hallucination-risk`, `validate-quality`, `validate-consistency`). The orchestrator `validate-gate.ts` itself is also excluded; it is not a check, it is the runner.

**Method:** for each validator, four readily-available proxies were extracted:

- **gate status** — blocking, advisory, or not-in-gate (parsed from `crux/validate/validate-gate.ts:244` `PARALLEL_STEPS`).
- **last-touch** — `git log -1 --format='%cs'` against the validator file.
- **last bug-fix** — `git log -i -1 --format='%cs|%s' --grep='fix\|bug'` against the validator file (the last commit whose subject mentions "fix" or "bug").
- **test sibling** — whether `<file>.test.ts` exists adjacent to the validator.

**Override rate is intentionally not used at this phase** (per ADR-0003 Phase 3). Re-measuring it requires Phase 1's gate-stage timing telemetry to mature first; without that telemetry, override rate cannot be reliably distinguished from "agent rebased onto main and regenerated baselines for unrelated reasons."

**Tier definitions** (from QUA-504, restated in ADR-0003):

- **S (Schema-class)** — invariant should be enforced at the database / schema layer (PG CHECK, Zod parse-time refusal, sync-handler 4xx). Migration target.
- **W (Wiki-content-class)** — content lint that should run on edit, not in CI gate. Move to /sync handler assertions or a content runtime check.
- **R (Runtime-class)** — keep as-is in the gate; load-bearing for a class of bug that no other layer can catch. ADR-0003's carveout names 6 ratchets explicitly excluded from deletion: `sourcing-lint-guard`, `entity-schema-drift`, `typed-client`, `workflow-secrets`, `no-bespoke-filter-chips`, `tsc-baseline`. Of these, only the first 5 are validator files in `crux/validate/`; `tsc-baseline` is the TypeScript baseline (`crux/validate/crux-tsc-baseline.txt`) and is not in this disposition's 67-validator set.

## Headline counts

| Tier | Count | Disposition |
|------|------|------|
| **S** | 23 | Migrate to PG CHECK / Zod / sync-handler refusal; delete validator after migration ships and bakes for ≥30d. |
| **W** | 10 | Move to edit-time / dashboard / content-publishing pipeline; consider deletion after migration. |
| **R** | 34 | Keep as gate validator. Includes the 5 named ratchets in this set, build-time-only static checks, and the 3 orchestrators/runners (`validate-daily`, `validate-data`, `validate-unified`). |

**Phase 4 deletion-candidate triage:** of the 23 S and 10 W validators, **9 are recommended for follow-up tickets in Phase 4** because they have a clear Schema/Sync-handler home AND are advisory-or-no-recent-bugs (low risk to demote/delete). The other 24 stay in the gate until their migration target is built. The 9 candidates are listed in the "Phase 4 follow-ups" section at the bottom.

## Disposition table

Columns: name | current-runs-in | has-test | last-touch | last bug-fix | S/W/R | recommendation | rationale.

`current-runs-in`: `gate-blocking` | `gate-advisory` | `not-in-gate` (only `validate-daily.ts` and `validate-data.ts` are not-in-gate; both are runners/orchestrators and are reached via `pnpm crux validate daily` / `pnpm crux validate data`).

| name | runs-in | test | last-touch | last-bugfix | tier | recommendation | rationale |
|------|---------|------|-----------|-------------|------|----------------|-----------|
| validate-ai-incidents-source-enum | gate-blocking | yes | 2026-04-29 | 2026-04-29 | **R** | keep | Cross-file enum-drift check (route Zod ↔ migration CHECK ↔ ingester). No runtime layer can compare two files; static is the only home. |
| validate-aiid-no-report-text | gate-blocking | yes | 2026-04-25 | — | **R** | keep | Legal-compliance grep (CC-BY-SA exclusions). Static is the only defence; runtime can't catch a column at design time. |
| validate-benchmark-result-provenance | gate-advisory | no | 2026-04-25 | 2026-04-25 | **W** | migrate to ingest pipeline | Queries prod for benchmark_results provenance. Belongs in the QUA-689 ingest path as a Zod refinement / sync-handler 4xx, not a gate query. |
| validate-component-refs | gate-blocking | no | 2026-04-16 | 2026-04-16 | **W** | migrate to MDX edit-time | Validates EntityLink/DataInfoBox refs in 700+ MDX files. Should run during page-authoring (already partially done by `crux/lib/rules/`). 627 LOC + no tests is a yellow flag — consider tests in Phase 4 if not migrated. |
| validate-controlled-vocab | gate-blocking | yes | 2026-04-29 | 2026-04-29 | **S** | migrate (partial); keep YAML-only fields | Doc itself notes PG-primary fields (personnel.role_type, divisions.*, entities.status) are now PG-CHECK-enforced. The YAML-only enums remain — promote to Zod refinements in entity loaders. |
| validate-cross-base | gate-blocking | yes | 2026-04-16 | 2026-04-16 | **R** | keep | WikiBase ↔ TableBase ↔ FactBase consistency requires reading all three; no single layer can enforce. |
| validate-cross-page-dates | gate-advisory | no | 2026-03-20 | 2026-03-20 | **W** | migrate to dashboard / consider deletion | Heuristic regex for date contradictions across MDX. No bug fixes since 2026-03-20 (~6 weeks). High false-positive risk per ADR Investigation. **Phase 4 candidate.** |
| validate-daily | not-in-gate | no | 2026-05-02 | 2026-05-02 | **R** | keep | Orchestrator, not a check. Runs the daily local+server suite. |
| validate-dangerous-patterns | gate-blocking | yes | 2026-04-29 | 2026-04-29 | **R** | keep (consider ESLint port) | Static code-pattern check (silent .catch, as any). Could be migrated to ESLint rules; until then, gate is the right home. |
| validate-data | not-in-gate | yes | 2026-04-16 | 2026-04-15 | **R** | keep (or fold into daily) | Standalone runner exposed via `crux validate data`. Reached only via daily; could be inlined there in Phase 4 with no behaviour change. |
| validate-directory-pages | gate-advisory | no | 2026-04-30 | 2026-04-30 | **W** | migrate to /internal dashboard | Sparse-directory + missing-fields advisory. Better as a `/internal/data-quality` row than as a gate step. |
| validate-display-formatting | gate-blocking | yes | 2026-05-03 | 2026-03-26 | **S** | migrate to Zod refusal | `[object Object]`, unescaped MDX, `null`/`undefined`/`NaN` literals in display fields are write-time invariants. Reject at sync-handler. |
| validate-display-names | gate-blocking | yes | 2026-03-29 | 2026-03-29 | **S** | migrate to Zod refusal | Raw stableIds in title fields = write-time invariant; the sync handler should 4xx, not the gate. |
| validate-dot-position | gate-blocking | no | 2026-04-11 | 2026-04-11 | **R** | keep (add tests in Phase 4) | UI layout pattern (dot indicator never first column). Static check is the only home. No tests is a yellow flag for a 286-LOC validator. |
| validate-drizzle-journal | gate-blocking | yes | 2026-03-28 | 2026-03-28 | **R** | keep | Build-time correctness (journal integrity, prefix uniqueness). No runtime layer can catch. |
| validate-entity-refs | gate-advisory | yes | 2026-03-16 | 2026-03-16 | **S** | migrate to FK / sync-handler refusal | Soft FK fields in TableBase records. Long-term: hard FKs. Short-term: sync-handler refuses unresolved refs. **Phase 4 candidate.** |
| validate-entity-schema-drift | gate-blocking | yes | 2026-05-02 | 2026-04-30 | **R** | keep (NAMED RATCHET) | Listed in ADR-0003 carveout. Excluded from deletion. |
| validate-factbase-entities | gate-advisory | no | 2026-04-16 | 2026-04-16 | **S** | migrate to FactBase load-fail | "Every FactBase entity has a TableBase entry" — should be a load-time invariant in `packages/factbase/`. **Phase 4 candidate.** |
| validate-factbase-entity-ids | gate-blocking | no | 2026-04-16 | 2026-03-28 | **S** | migrate to FactBase load-fail | Duplicate-ID + ID-consistency check. Should be enforced at FactBase + TableBase load (both already use Zod parsers). |
| validate-factbase-fact-unit-field | gate-blocking | yes | 2026-04-20 | 2026-04-20 | **S** | migrate to FactBase Zod | The doc explicitly says "the loader silently drops `unit:` — that's the bug". The fix is for the loader to refuse, not for a static validator to scold. |
| validate-factbase-record-refs | gate-blocking | yes | 2026-04-29 | 2026-04-29 | **S** | migrate to sync-handler refusal | sid_ refs that don't resolve = sync-handler 4xx territory. **Phase 4 candidate.** |
| validate-factbase-schema | gate-blocking | no | 2026-04-03 | 2026-04-03 | **S** | promote to load-time fail-closed | This *is* the FactBase Zod schema runner. Run it inside the loader and fail-closed there; the gate step becomes a no-op. |
| validate-factbase-stableid | gate-blocking | no | 2026-04-05 | 2026-04-05 | **R** | keep | Banned-pattern static check (`getKBLatest("slug")` vs `("sid_…")`). Code-pattern; static is the only home. |
| validate-fk-swap-double-drop | gate-blocking | yes | 2026-04-18 | 2026-04-18 | **R** | keep | Migration safety check (QUA-549 incident). Build-time only. |
| validate-framework-thresholds | gate-blocking | yes | 2026-04-29 | 2026-04-28 | **W** | migrate to sync-handler / ingester | Runtime DB query for ingest provenance. Belongs in the QUA-711 ingester, not the gate. **Phase 4 candidate.** |
| validate-framework-versions | gate-blocking | yes | 2026-04-29 | 2026-04-28 | **W** | migrate to sync-handler / ingester | Same shape as `validate-framework-thresholds`. **Phase 4 candidate.** |
| validate-inline-pagination | gate-blocking | yes | 2026-04-04 | 2026-04-04 | **R** | keep (consider ESLint port) | Banned-pattern static check (raw `Math.min(query("limit"))`). Code-pattern. |
| validate-kb-entity-slugs | gate-blocking | yes | 2026-04-16 | 2026-04-16 | **S** | migrate to FactBase load-fail | FactBase !ref targets must exist as TableBase entities — referential integrity. Move to FactBase loader. |
| validate-manifest-sourcing | gate-blocking | yes | 2026-04-29 | 2026-04-29 | **S** | migrate to ingest pipeline | "Newly-added manifest must have ≥1 sourced record" — this is an ingester pre-flight, not a gate check. |
| validate-mdx-compile | gate-blocking | no | 2026-02-28 | 2026-02-28 | **W** | keep until Next.js build is in gate | Compiles MDX. The Next.js full build also catches this; doc says this is "advisory smoke-test, full build is authoritative". Could delete once full build runs in gate (currently --full only). **Phase 4 candidate.** |
| validate-migration-large-table-ddl | gate-blocking | yes | 2026-04-30 | 2026-04-30 | **R** | keep | Migration safety check (QUA-294 — 12h prod outage). Build-time only. Highest-value validator in the set. |
| validate-no-anthropic-api-key-read | gate-blocking | yes | 2026-04-19 | 2026-04-19 | **R** | keep | Security ratchet (QUA-612). Static is the only home. |
| validate-no-bespoke-filter-chips | gate-blocking | no | 2026-05-01 | 2026-05-01 | **R** | keep (NAMED RATCHET) | Listed in ADR-0003 carveout. Excluded from deletion. |
| validate-no-console-log | gate-blocking | yes | 2026-02-28 | 2026-02-28 | **R** | keep (consider ESLint port) | Banned-pattern static check. Could be ESLint `no-console` with overrides; until then, gate. |
| validate-no-sourcinged | gate-blocking | yes | 2026-04-30 | 2026-04-30 | **R** | keep (small ratchet) | Tiny QUA-897 regression check. Cheap to keep. |
| validate-numeric-consistency | gate-advisory | no | 2026-04-28 | 2026-04-28 | **W** | migrate to dashboard / consider deletion | Heuristic cross-page numeric contradictions. Self-described as advisory; high false-positive risk. **Phase 4 candidate.** |
| validate-oecd-aim-no-article-body | gate-blocking | no | 2026-04-29 | — | **R** | keep | Legal-compliance grep (OECD AIM no-license). Same shape as aiid-no-report-text. |
| validate-orphan-entities | gate-advisory | yes | 2026-04-29 | 2026-04-28 | **S** | migrate to FK / cleanup job | Ghost PG entities. Migration target: hard FK + ON DELETE CASCADE on YAML→PG sync. |
| validate-person-refs | gate-blocking | no | 2026-04-16 | 2026-04-16 | **S** | migrate to FactBase Zod | Person `!ref` resolution + display-name presence. FactBase loader / sync-handler concern. |
| validate-policy-stakeholders-strict | gate-blocking | yes | 2026-04-30 | 2026-04-30 | **S** | migrate via fail-loud sync 4xx | The doc itself: validator imports the sync route's Zod schema. The fix is the build helper failing loud on Zod 400, not a parallel gate run. (Build helper fix is already in place per the doc; gate becomes redundant.) |
| validate-prompt-escaping | gate-blocking | no | 2026-03-29 | 2026-03-29 | **R** | keep | Banned-pattern security check (XML interpolation). Static-only. |
| validate-related-entry-types | gate-blocking | yes | 2026-03-27 | 2026-03-27 | **S** | migrate to Zod refinement | `relatedEntries[].type` vs actual entity type — Zod refinement at YAML load. |
| validate-rendered-sid | gate-blocking | no | 2026-04-04 | 2026-04-04 | **S** | migrate to build-data fail-closed | "Last-line-of-defence" check on built JSON. Move into `apps/web/scripts/build-data.mjs` fail-closed checks (already partially fail-closed per QUA-772). |
| validate-resource-quality | gate-advisory | yes | 2026-05-03 | 2026-03-21 | **W** | migrate to scraper pipeline | HTML in titles, scraping artifacts. Belongs in the resource-ingestion path, not the gate. **Phase 4 candidate** (consider deletion: the warnings are informational, the errors are content-level). |
| validate-resource-refs | gate-advisory | yes | 2026-04-29 | — | **S** | migrate to FK / sync refusal | author_entity_ids JSONB resolution. Sync-handler refusal territory. |
| validate-returning-guard | gate-blocking | no | 2026-02-22 | 2026-02-22 | **R** | keep (consider ESLint port) | Banned-pattern static check. No bug-fix touches in 2.5 months — stable. |
| validate-scorecard-refs | gate-advisory | no | 2026-04-29 | 2026-04-28 | **S** | migrate to PG constraint / FK | `is_latest` invariant — already a partial unique index per the doc. The FK side is also schema-enforced. Validator is the runtime double-check; promote to fail-closed. |
| validate-sid-display | gate-blocking | yes | 2026-04-24 | 2026-04-24 | **S** | migrate to sync-handler refusal | sid_ in display-name columns = sync-handler 4xx territory. Lots of callers, big migration — keep gate version until sync handlers all refuse. |
| validate-soft-fks | gate-advisory | yes | 2026-04-29 | 2026-03-29 | **S** | migrate to hard FKs | The validator name itself names the migration target. **Phase 4 candidate** (likely a multi-PR migration). |
| validate-sourcing-lint-guard | gate-blocking | yes | 2026-04-29 | 2026-04-29 | **R** | keep (NAMED RATCHET) | Listed in ADR-0003 carveout. Excluded from deletion. |
| validate-stale-content | gate-advisory | no | 2026-03-20 | 2026-03-20 | **W** | migrate to dashboard / consider deletion | Heuristic stale-page detection. No bug-fix touches in 6 weeks. Better as a `/internal/maintenance` row. **Phase 4 candidate.** |
| validate-table-formatting | gate-blocking | yes | 2026-05-01 | 2026-05-01 | **R** | keep (named QUA-1006 ratchet) | Locks down the QUA-1006 sweep. Effectively a ratchet — recently-landed regression-prevention. |
| validate-table-states | gate-blocking | yes | 2026-05-02 | 2026-05-02 | **R** | keep (named QUA-1008 ratchet) | Locks down the QUA-1008 sweep. Same shape as table-formatting. |
| validate-tablebase-completeness | gate-blocking | yes | 2026-04-14 | 2026-04-14 | **R** | keep | Sync-route completeness (delete-batch, things sync, entity ref). Cross-file static check. |
| validate-tablebase-registry | gate-blocking | yes | 2026-04-30 | 2026-04-30 | **R** | keep | Registry ↔ filesystem sync (QUA-456). Cross-file static. |
| validate-temporal | gate-blocking | yes | 2026-04-16 | 2026-04-15 | **S** | migrate to FactBase + entity Zod | Calendar validity (month 00, day 32, Feb 30). Belongs in the date-parsing layer. |
| validate-things-denorm-dead | gate-blocking | yes | 2026-04-24 | — | **R** | keep (named QUA-507 ratchet) | Banned re-introduction of dropped columns. Static-only. |
| validate-third-party-eval-refs | gate-blocking | yes | 2026-04-28 | 2026-04-28 | **R** | keep | Cross-file enum-drift check (route Zod ↔ migration CHECK ↔ ingester). Same shape as ai-incidents-source-enum. |
| validate-typed-client | gate-blocking | yes | 2026-05-02 | 2026-05-02 | **R** | keep (NAMED RATCHET) | Listed in ADR-0003 carveout. Excluded from deletion. |
| validate-unified | not-in-gate (orchestrator) | no | 2026-04-27 | 2026-04-26 | **R** | keep | Orchestrator for the `crux/lib/rules/` ruleset. Not a check itself — it dispatches the unified rules listed in `UNIFIED_BLOCKING_RULES`. |
| validate-untyped-rows | gate-blocking | no | 2026-02-27 | 2026-02-27 | **R** | keep (consider ESLint port) | Banned `(r: any)` cast in routes. Stable: no fixes in 2+ months. |
| validate-url-normalize | gate-blocking | yes | 2026-04-16 | 2026-04-16 | **R** | keep (QUA-341 ratchet) | Locks down the QUA-341 helper consolidation. Banned-pattern static. |
| validate-verdict-priority | gate-blocking | yes | 2026-04-28 | 2026-04-28 | **R** | keep (QUA-429 ratchet) | Banned distinct verdict-priority maps. Static. |
| validate-workflow-secrets | gate-advisory | yes | 2026-04-29 | 2026-04-29 | **R** | keep (NAMED RATCHET) | Listed in ADR-0003 carveout. Excluded from deletion. |
| validate-workspace-dep-coverage | gate-blocking | yes | 2026-04-22 | 2026-04-22 | **R** | keep | Workspace-package undeclared-import + Dockerfile COPY check (QUA-449/598/605/654). Build-time only. |
| validate-yaml-entity-refs | gate-blocking | no | 2026-03-19 | 2026-03-19 | **S** | migrate to Zod refinement | YAML field-level entity references. Same shape as `validate-related-entry-types`. |
| validate-yaml-schema | gate-blocking | no | 2026-03-11 | 2026-03-03 | **S** | promote to load-time fail-closed | This *is* the YAML Zod runner. Move it into the loader, fail-closed. Same migration shape as `validate-factbase-schema`. |

## Phase 4 follow-up candidates (9)

The following 9 validators are filed as **QUA-1093** ("ADR-0003 Phase 4: 9 W/S-class deletion candidates from Phase 3 disposition") — a single batch ticket per ADR-0003 § Phase 3 ("file one ticket per W-class deletion candidate (or batch into a single 'Phase 3 W-class deletions' ticket if the count is small)"). The count is small enough — 7 W-class + 2 S-class with clear migration targets — to warrant a single batch ticket.

| Validator | Tier | Disposition reason |
|-----------|------|--------------------|
| validate-cross-page-dates | W | Heuristic, advisory, 6+ weeks since last touch. Move to dashboard or delete. |
| validate-numeric-consistency | W | Heuristic, advisory, high FP risk. Move to dashboard or delete. |
| validate-stale-content | W | Heuristic, advisory, 6+ weeks since last touch. Move to dashboard or delete. |
| validate-resource-quality | W | Mostly advisory warnings; the few errors are content-level. Move to scraper. |
| validate-framework-thresholds | W | Runtime DB query. Belongs in the QUA-711 ingester. |
| validate-framework-versions | W | Runtime DB query. Belongs in the QUA-711 ingester. |
| validate-mdx-compile | W | Subsumed by full Next.js build; keep advisory until full build is in gate. |
| validate-entity-refs | S | Soft-FK migration target; sync-handler refusal. |
| validate-factbase-entities | S | FactBase loader fail-closed; sync-handler refusal. |

The other 25 S/W validators have a clearer "wait for migration target" status — keep them in the gate until their PG CHECK / Zod refinement / sync-handler 4xx ships, then delete in a follow-up PR. Per ADR-0003 § "Carveout language": deletion is permitted only when the validator is named in this disposition list (which all 67 are). The named-ratchet exclusions (sourcing-lint-guard, entity-schema-drift, typed-client, workflow-secrets, no-bespoke-filter-chips) are not deletion candidates regardless of migration shape.

## Notes on the proxies

- **Last-touch is noisy.** A 2026-05-03 last-touch on `validate-display-formatting` is not a bug-fix; the most recent touch was a feature-add unrelated to the validator's behaviour. That's why "last bug-fix" (commits whose subject mentions `fix` or `bug`) is the better health signal. 4 validators have an empty `last-bugfix` column — they have either never had a bug fix, or their fixes are in commits whose subject doesn't match the grep. These are flagged as either "very stable" or "very recent" — not as a separate red flag.
- **No-test signal.** 22 of 67 (33%) have no `.test.ts` sibling. This is consistent with the codebase scout's headline "48/73 = 66% test coverage". Of the no-test set, 5 are recommended Phase 4 candidates (so testing them is moot if they're being migrated out); the rest are `keep` recommendations and should ideally get tests in Phase 4. The largest no-test validator is `validate-component-refs.ts` (627 LOC) — already flagged in the codebase scout as a top-5 risk.

## Exit criterion

Per ADR-0003 § Phase 3 Exit: "every one of the 67 validators has a documented S/W/R tier in the disposition table." All 67 rows are present in the table above. Exit met.

## Carveout dependency reminder

Deletion recommendations from this disposition can only be acted on after Phase 1's `proactive-github-filing.md` carveout is merged (otherwise deletion trips the "silencing = symptom-patch" rule). Phase 3's output is the disposition list; Phase 1+2 must ship before any actual deletion happens. This file is a tier assignment, not a deletion plan.
