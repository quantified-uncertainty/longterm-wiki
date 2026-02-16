## 2026-02-16 | claude/complete-new-pages-kawqG | Fix conflicting numeric IDs on overview pages

**What was done:** Fixed all 9 overview pages from PR #118 which had numeric IDs (E687–E695) that conflicted with existing YAML entities from a previous remapping PR. Reassigned them to E710–E718.

**Pages:** safety-orgs-overview, labs-overview, community-building-overview, government-orgs-overview, governance-overview, accident-overview, epistemic-overview, structural-overview, misuse-overview

**Issues encountered:**
- All 9 overview pages had `numericId` values that collided with existing entities, causing slug-based URLs to redirect to the wrong page (e.g., `/wiki/safety-orgs-overview` → E687 → `ai-acceleration-tradeoff`)
- The build-data conflict checker didn't catch this because overview pages lack `entityType` in frontmatter, so they're never added to the entities array during conflict detection

**Learnings/notes:**
- The `numericId` conflict detector in `build-data.mjs` only checks entities (YAML + frontmatter with `entityType`), not page-level `numericId` fields. Pages without `entityType` can silently claim IDs that belong to other entities.
- This is a latent bug worth fixing in the build script to prevent recurrence.
