## 2026-02-18 | claude/resolve-issue-253-quLpk | Fix entity description propagation pipeline

**What was done:** Fixed entity description propagation across the data pipeline (issue #253). Added description enrichment from page frontmatter and YAML content.intro in entity-transform.mjs, frontmatter-scanner.mjs, and mdx-generator.mjs. Extracted shared text-utils.mjs to eliminate DRY violation. Fixed stats.withDescription to reflect post-enrichment count. Added 17 unit tests for text-utils. Entity description coverage: 581/747 (78%) → 747/747 (100%).

**Pages:** epistemics

**Model:** opus-4-6

**Duration:** ~1h

**Issues encountered:**
- Only 1 MDX file truly lacked description field; the real issue was pipeline gaps not propagating descriptions to entities
- Statistics computed pre-transformation showed misleading withDescription count (699 vs actual 747)
- Two independent description extraction implementations had subtle differences (bold stripping, period handling)

**Learnings/notes:**
- Entity descriptions have a 3-tier fallback: YAML entity → page frontmatter → content.intro extraction
- Consumer fallback chains (search, SEO, explore) use: llmSummary → page.description → entity.description
- The mdx-generator regenerates stub files each build, so manual edits to generated MDX files are overwritten
