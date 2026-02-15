## 2026-02-15 | claude/importance-ranking-system-G0IMJ | Importance ranking system

**What was done:** Built a ranking-based importance scoring system. Instead of arbitrary 0-100 numbers, pages are maintained in an ordered list (most important first) in `data/importance-ranking.yaml`. The ranking is the source of truth; numeric scores are derived from position. Added a new `importance` CLI domain with commands: `seed` (bootstrap from existing scores), `show` (view rankings), `rank` (LLM-assisted binary search insertion), and `sync` (write derived scores to frontmatter). Seeded initial ranking from 524 pages with existing importance scores.

**Pages:** (no page content changes — infrastructure only)

**Issues encountered:**
- None

**Learnings/notes:**
- 530 of ~645 pages already had non-zero importance scores, so the initial seed was well-populated
- The ranking file is ~645 entries long — manageable for manual editing or Claude Code review
- Score derivation uses linear interpolation: position 1 → 95, last position → 5
- The `rank` command uses Haiku for pairwise comparisons (binary search = ~10 comparisons per page for 645 pages)
