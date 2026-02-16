## 2026-02-16 | claude/investigate-arxiv-paper-UmGPu | Singapore Consensus on AI Safety

**What was done:** Investigated arXiv:2506.20702 (The Singapore Consensus on Global AI Safety Research Priorities) and integrated it into the wiki. Updated the international-summits page with a new SCAI section and Mermaid diagram, fixed the broken Singapore Consensus resource in web-other.yaml, updated Bengio/Russell/Tegmark pages with references, created a new dedicated singapore-consensus page with entity E694, and registered the entity in responses.yaml.

**Pages:** international-summits, yoshua-bengio, stuart-russell, max-tegmark, singapore-consensus

**Issues encountered:**
- Crux content create pipeline failed due to better-sqlite3 native binding not being built (pnpm install --ignore-scripts was needed due to puppeteer failure). Rebuilt the binding manually.
- Crux pipeline's Perplexity research phase failed with network errors ("fetch failed"), so the page was written manually following the fallback procedure in CLAUDE.md.
- CLAUDE.md lists tier names (polish/standard/deep) that don't match the actual page-creator.ts tiers (budget/standard/premium).

**Learnings/notes:**
- The Crux page-creator.ts uses tier names "budget", "standard", "premium" — not "polish", "standard", "deep" as documented in CLAUDE.md. The page-improver uses polish/standard/deep. CLAUDE.md should be updated to reflect this.
- better-sqlite3 requires manual rebuild when pnpm install uses --ignore-scripts.
