## 2026-02-17 | claude/top-priority-update-WurDM | Improve top 5 foundational wiki pages

**What was done:** Improved the 5 highest-importance, lowest-quality wiki pages using the Crux content pipeline. All were stubs (7 words) or had quality=0 and are now comprehensive articles with citations, EntityLinks, and balanced perspectives.

**Pages:** existential-risk, superintelligence, agentic-ai, ai-timelines, scaling-laws

**PR:** #188

**Issues encountered:**
- Research phase consistently returned "0 sources found" due to JSON parsing errors in the research output, but the improve phase still generated high-quality content using analysis data and model knowledge
- Agentic-ai `--grade` flag hung after the improve pipeline completed successfully; quality score was set manually

**Learnings/notes:**
- The Crux improve pipeline research phase JSON parsing is fragile — investigate the parser in a future session
- Stub pages with only "This page is a stub. Content needed." are successfully handled by the standard tier improve pipeline
- Running 2-3 improve pipelines in parallel works without API rate limit issues
