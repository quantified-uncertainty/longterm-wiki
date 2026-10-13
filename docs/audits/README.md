# Audits

Long-form enumerations of subsystem state produced by focused audit sessions. Each audit is **read-only knowledge, not shipping code** — it inventories write sites, consumers, derived columns, and bugs across a specific codebase area so a later implementation PR has complete context.

When to add to this directory:

- A refactor's precondition is "know every place X is touched" and the answer is >10 sites
- An architectural decision depends on enumerating a constraint across many files
- A future implementer needs to be able to re-verify completeness with `rg` — the audit ends with the exact grep commands that reproduce its conclusions

Each audit should link back to the Linear ticket that scoped it and forward to the ticket(s) it blocks or informs.

## Current audits

| File | Scope | Status | Linear |
|---|---|---|---|
| [`things-denormalization-audit.md`](./things-denormalization-audit.md) | Every write site and consumer of `things.title` / `things.description` / `things.parent_title`, plus the `*_display_name` sibling pattern across 13 tables. Precondition for eliminating write-time denormalization. | Complete 2026-04-13 | [QUA-414](https://linear.app/quantifieduncertainty/issue/QUA-414) / [QUA-408](https://linear.app/quantifieduncertainty/issue/QUA-408) Tier 4b |
| [`qua-303-sourcing-rename-audit.md`](./qua-303-sourcing-rename-audit.md) | Full PG FK / view / index / call-site inventory for the `source_check_*` → `sourcing_*` rename. Draft Phase 1 + Phase 3 migration SQL in `apps/wiki-server/scripts/`. Precondition for QUA-303 execution. | Complete 2026-04-13 | [QUA-303](https://linear.app/quantifieduncertainty/issue/QUA-303) / [QUA-102](https://linear.app/quantifieduncertainty/issue/QUA-102) umbrella |
| [`2026-04-14-linear-refactor.md`](./2026-04-14-linear-refactor.md) | Linear metadata hygiene + project scope + epic hierarchy + label taxonomy deep audit. 16 orphans assigned, 22 issues re-projected, 22 labels purged (zero now), 2 projects closed, 1 epic decomposed. Produced `crux linear hygiene` tool + `linear-project-ownership.md` doctrine. | Complete 2026-04-14 | No single ticket — spans QUA-183, QUA-362, QUA-465 (dup), and the AI Power / Tablebase projects |
| [`phase-3-equivalence-audit.md`](./phase-3-equivalence-audit.md) | Field-level equivalence audit comparing YAML-sourced `database.json` vs a PG-sourced prototype across 2,809 entities (+ sidecar FactBase audit). Supporting data in `phase-3-equivalence-audit.diff.json` (17k-row A/C/D classification) and `phase-3-equivalence-audit-factbase.diff.json`. 7 findings: 2 real sync bugs (`relatedEntries` column-target mismatch, `data/organizations.yaml` not synced), 1 structural `wikiId` allocator artifact, 4 classified gaps/wins. Verdict: **GO**, 4 weeks to cutover. Precondition for Phase 3 cutover PR. | Complete 2026-04-15 | [QUA-510](https://linear.app/quantifieduncertainty/issue/QUA-510) / [QUA-408](https://linear.app/quantifieduncertainty/issue/QUA-408) Phase 3 |
| [`rules-file-classification.md`](./rules-file-classification.md) | KEEP/SLIM/DELETE classification of all 29 `.claude/rules/*.md` files for [QUA-408](https://linear.app/quantifieduncertainty/issue/QUA-408) Phase 5. 18 KEEP, 8 SLIM, 3 DELETE. 11 verdicts blocked on Phase 1/3/4/4b ships. Identifies 4 cluster-consolidation candidates (Linear/agent/PR workflow, code conventions) for follow-up Phase 5 design work. | Complete 2026-04-15 | [QUA-509](https://linear.app/quantifieduncertainty/issue/QUA-509) / [QUA-408](https://linear.app/quantifieduncertainty/issue/QUA-408) Phase 5 |
| [`v1-v2-engine-consolidation.md`](./v1-v2-engine-consolidation.md) | Page-authoring pipeline: V1 (fixed, default) vs V2 (agent, opt-in) engine inventory + consolidation options. Finds the labels mislead (V2 isn't "the new version"), real load-bearing unit is V1's phase library (imported by auto-update, not the V1 runner), and V2's batch mode is unused by the largest batch consumer. Notes V2 has qualitative successful runs (#752, #772, #815) but **zero head-to-head V1 vs V2 benchmarks** — separate benchmark ticket filed. Recommends **Option E**: rename flags/dirs first (`--engine=fixed\|agent`), then extract phases to shared `crux/authoring/phases/`. Defers "migrate to V2" until QUA-557 benchmark data lands. | Draft 2026-04-16 | [QUA-556](https://linear.app/quantifieduncertainty/issue/QUA-556) / [QUA-557](https://linear.app/quantifieduncertainty/issue/QUA-557) |

| [`2026-06-09-deep-review.md`](./2026-06-09-deep-review.md) | Six-agent codebase review against QUA-408 direction and all ADRs. Filed QUA-1153–1160; confirmed QUA-130, QUA-636, QUA-1148. Companion to the deletion catalog and refactor portfolio. | Complete 2026-06-09 | [QUA-1153](https://linear.app/quantifieduncertainty/issue/QUA-1153)–[QUA-1160](https://linear.app/quantifieduncertainty/issue/QUA-1160) |
| [`2026-06-09-deletion-catalog.md`](./2026-06-09-deletion-catalog.md) | Three-agent mechanical dead-code audit with reachability verification. ~17,400 LOC certainly deletable + ~2,500 after one-line deregistrations + ~5.5 MB assets. Includes ⚠️ Corrections to prior kill lists (ADR-0003 orphan-validator list and 2026-04-27 audit contain ~7,800 LOC of stale claims). Execution umbrella: QUA-1163. | Complete 2026-06-09 | [QUA-1163](https://linear.app/quantifieduncertainty/issue/QUA-1163) |

## Related rules files

- `docs/agent-rules/tablebase-sync-factory.md` — sync handler factory + shared helpers (points here for `things` write paths)
- `docs/agent-rules/three-bases-architecture.md` — TableBase/FactBase/WikiBase ontology (points here for `things` cross-base index)
- `docs/agent-rules/linear-project-ownership.md` — scope-boundary doctrine derived from `2026-04-14-linear-refactor.md`
- `docs/agent-rules/linear-integration.md` — Linear ↔ GitHub integration (§ 9 links project ownership + `crux linear hygiene`)
