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

## Related rules files

- `.claude/rules/entity-sync-pipeline.md` — sync handler infrastructure (points here for `things` write paths)
- `.claude/rules/three-bases-architecture.md` — TableBase/FactBase/WikiBase ontology (points here for `things` cross-base index)
- `.claude/rules/linear-project-ownership.md` — scope-boundary doctrine derived from `2026-04-14-linear-refactor.md`
- `.claude/rules/linear-integration.md` — Linear ↔ GitHub integration (§ 9 links project ownership + `crux linear hygiene`)
