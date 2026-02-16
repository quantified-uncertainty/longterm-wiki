## 2026-02-16 | claude/issue-163-longterm-wiki-8NdjH | Fix CLAUDE.md tier names and entity types

**What was done:** Fixed incorrect tier names for `content create` (was `polish`/`standard`/`deep`, now correctly `budget`/`standard`/`premium`) and added explicit tier list for `content improve`. Updated entity types list to be canonical and reference `crux/lib/category-entity-types.ts`.

**Issues encountered:**
- None

**Learnings/notes:**
- `content create` tiers: budget (~$2-3), standard (~$4-6), premium (~$8-12)
- `content improve` tiers: polish (~$2-3), standard (~$5-8), deep (~$10-15)
- Entity types are defined in `crux/lib/category-entity-types.ts`
