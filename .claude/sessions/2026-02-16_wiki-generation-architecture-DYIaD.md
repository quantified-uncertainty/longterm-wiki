## 2026-02-16 | claude/wiki-generation-architecture-DYIaD | Wiki generation architecture research & proposal

**What was done:** Researched state-of-the-art approaches to scalable wiki generation (Stanford STORM, Microsoft GraphRAG, CrewAI, Self-Refine, SemanticCite, Anthropic multi-agent systems, KARMA) and wrote a comprehensive architecture proposal for multi-agent, multi-pass wiki page generation. The proposal covers 8 specialist agents, 12+ composable passes, knowledge graph-driven content planning, dynamic computation embedding, and iterative refinement loops.

**Pages:** wiki-generation-architecture

**Issues encountered:**
- None significant. pnpm install required --ignore-scripts due to puppeteer postinstall failure, but this is a known environment issue.

**Learnings/notes:**
- Stanford STORM's perspective-guided research (mining perspectives from similar articles) is a strong idea we could adopt
- Anthropic's own research found 90.2% improvement from multi-agent vs single-agent -- validates the architecture direction
- The key insight from CrewAI: "Squeezing too much into one agent causes context windows to blow up, too many tools confuse it, and hallucinations increase"
- GraphRAG's community summaries could be computed at build-time from our existing entity clusters
- SemanticCite's per-claim citation classification (SUPPORTED/PARTIALLY_SUPPORTED/UNSUPPORTED) is more rigorous than our current binary verify-sources approach
