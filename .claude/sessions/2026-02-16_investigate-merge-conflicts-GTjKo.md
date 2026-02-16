## 2026-02-16 | claude/investigate-merge-conflicts-GTjKo | Investigate merge conflict patterns

**What was done:** Analyzed ~28 recent PRs and the codebase architecture to identify root causes of frequent merge conflicts. Identified three primary causes: sequential numericId collisions across parallel branches, large append-only YAML entity files, and lack of pre-merge validation. Provided ranked recommendations including eliminating numericIds in favor of slugs, splitting YAML files per-entity, and hash-based ID allocation.

**Pages:** (none - research/analysis only)

**Issues encountered:**
- None

**Learnings/notes:**
- The numericId system (E1..E702) is the single biggest source of merge conflicts -- sequential counter computed at build time races across parallel branches
- 4 YAML files hold ~60% of all entities, making append conflicts very common
- ID collisions are only detected post-merge in CI, sometimes breaking main
- Eliminating numericIds entirely (using slugs as canonical IDs) would remove the whole class of ID collision problems
