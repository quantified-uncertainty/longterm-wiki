## 2026-02-16 | claude/complete-new-pages-kawqG | Fix conflicting numeric IDs + add integrity checks

**What was done:** Fixed all 9 overview pages from PR #118 which had numeric IDs (E687-E695) that conflicted with existing YAML entities. Reassigned to E710-E718. Then hardened the system to prevent recurrence:
1. Added page-level numericId conflict detection to `build-data.mjs` (build now fails on conflicts)
2. Created `numeric-id-integrity` global validation rule (cross-page uniqueness, format validation, entity conflict detection)
3. Added `numericId` and `subcategory` to frontmatter Zod schema with format regex

**Pages:** safety-orgs-overview, labs-overview, community-building-overview, government-orgs-overview, governance-overview, accident-overview, epistemic-overview, structural-overview, misuse-overview

**PR:** #168

**Issues encountered:**
- All 9 overview pages had `numericId` values that collided with existing entities, causing slug-based URLs to redirect to the wrong page
- The build-data conflict checker didn't catch this because overview pages lack `entityType` in frontmatter
- Had to handle the legitimate alias case where YAML entities render at differently-named pages (e.g. `tmc-epistemics` entity → `epistemics` page)

**Learnings/notes:**
- Pages without `entityType` in frontmatter are invisible to `scanFrontmatterEntities()`, so their numericIds were never checked for conflicts
- The `pathRegistry` can be used to detect legitimate entity→page aliases vs real conflicts
