## 2026-02-19 | claude/resolve-issue-254-O2Fdp | Migrate existing pages to declare entityType in frontmatter

**What was done:** Added `entityType: approach` to the 2 remaining MDX pages in the `responses` category that were missing it (`recoding-america.mdx` and `state-capacity-ai-governance.mdx`). The migration script (`crux/scripts/migrate-entity-types.mjs`) already existed and was run to apply the changes.

**Pages:** recoding-america, state-capacity-ai-governance

**Model:** sonnet-4

**Duration:** ~15min

**Issues encountered:**
- The issue description said "~600 existing pages" still needed migration, but nearly all had already been done in prior sessions. Only 2 non-index pages remained.
- The 7 `index.mdx` files in entity-required categories correctly remain without `entityType` (they're directory listings, not entities).

**Learnings/notes:**
- The migration script at `crux/scripts/migrate-entity-types.mjs` skips `index.mdx` files, which is correct.
- YAML entities (`state-capacity-ai-governance` type=concept, `recoding-america` type=resource) take precedence over the frontmatter `entityType: approach` per build-data.mjs logic — the frontmatter addition is safe and additive.
