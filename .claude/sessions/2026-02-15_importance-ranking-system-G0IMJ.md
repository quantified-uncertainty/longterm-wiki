## 2026-02-15 | claude/importance-ranking-system-G0IMJ | Importance ranking system

**What was done:** Built a two-dimension importance ranking system. Pages are maintained in ordered lists (most→least important) with numeric scores derived from position.

Session 1: Created core ranking infrastructure — `seed`, `show`, `rank`, `sync` commands. Seeded initial ranking from existing scores.

Session 2: Added `rerank` command with batch sort + merge algorithm for LLM-assisted full ranking. Iteratively tested with 20, 20, 40-page samples before running all 644 pages. Discovered merge artifacts (important pages ending up at bottom) — fixed with verification pass. User requested two importance dimensions: readership (broad/foundational topics for readers) and research (narrow/neglected topics with insight potential). Restructured entire system for multi-dimension support. Ran full readership verification pass and full research ranking.

Session 3: Wired research importance scores through the full stack — synced `researchImportance` to all page frontmatter (629 pages), added to build pipeline, Page interface, and PageStatus UI (new orange/amber "Research" score ring). Created `/internal/importance-rankings` dashboard page with sortable table showing both readership and research scores side by side. Added to internal nav under Dashboards & Tools.

**Pages:** importance-ranking (internal documentation), importance-rankings (new internal dashboard)

**Issues encountered:**
- Binary search merge artifacts: pages from later batches accumulated comparison errors, causing important concepts (mesa-optimization, sleeper agents, treacherous turn) to sink to the bottom. Fixed by adding verification pass that re-sorts overlapping windows of 20 pages.
- `~\$` pattern in MDX report page triggered test failures. Fixed by using `≈\$` (Unicode approximately symbol).

**Learnings/notes:**
- Full rerank of 644 pages costs ≈$1-2 with Haiku (26 batch sorts + ≈5000 binary search comparisons + 63 verification windows)
- Verification pass is essential after merge — moved 1259 pages on readership ranking
- Research dimension prompt emphasizes: insight potential, neglectedness, decision relevance, crux resolution
- Readership dimension prompt emphasizes: centrality, foundational dependency, breadth, real-world relevance
