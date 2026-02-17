## 2026-02-17 | claude/wiki-auto-update-system-0stG2 | Auto-update system

**What was done:** Built a news-driven wiki auto-update system that fetches RSS feeds and web searches, builds a relevance-scored digest, routes news items to wiki pages, and executes improvements through the existing crux content pipeline. Includes CLI commands, GitHub Actions workflow for daily scheduled runs, and run history tracking.

**Pages:** (none — infrastructure-only)

**Issues encountered:**
- None

**Learnings/notes:**
- The existing `crux updates` system (staleness-based) is complementary — auto-update is news-driven while updates is schedule-driven
- RSS parsing uses lightweight regex extraction rather than an XML parser dependency
- Web search sources use the existing Anthropic web_search tool via the LLM layer
- The system has a two-stage routing approach: fast entity ID matching first, then LLM routing for unmatched items
- Budget controls are built into both the CLI and the GitHub Actions workflow
