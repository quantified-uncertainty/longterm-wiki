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

## Related rules files

- `.claude/rules/entity-sync-pipeline.md` — sync handler infrastructure (points here for `things` write paths)
- `.claude/rules/three-bases-architecture.md` — TableBase/FactBase/WikiBase ontology (points here for `things` cross-base index)
