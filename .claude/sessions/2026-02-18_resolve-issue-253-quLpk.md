## 2026-02-18 | claude/resolve-issue-253-quLpk | Fix missing entity descriptions

**What was done:** Fixed the data pipeline to propagate descriptions from MDX frontmatter to auto-created entities (frontmatter-scanner.mjs, entity-transform.mjs), updated the MDX generator to include descriptions for YAML-first entities, and added descriptions to 6 person entities in people.yaml. Entity description coverage went from 581/747 (78%) to 747/747 (100%).

**Pages:** epistemics

**Model:** opus-4-6

**Duration:** ~30min

**Issues encountered:**
- The `epistemics.mdx` file is auto-generated from YAML by the build pipeline, so manual edits get overwritten; had to update the MDX generator instead
- The build-time "With descriptions" stat counts raw entities before transformation enrichment, so it shows 699 while typed entities have 747/747

**Learnings/notes:**
- Entity descriptions come from three sources: YAML entity definitions, MDX frontmatter (via frontmatter-scanner.mjs), and page data enrichment (via entity-transform.mjs)
- The `tmc-*` entities use `content.intro` as their descriptive text, which can be extracted as descriptions
- The "With descriptions" stat in build output reflects pre-transformation counts
