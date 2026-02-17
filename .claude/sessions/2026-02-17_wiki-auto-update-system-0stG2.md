## 2026-02-17 | claude/wiki-auto-update-system-0stG2 | Auto-update system

**What was done:** Built a news-driven wiki auto-update system that fetches RSS feeds and web searches, builds a relevance-scored digest, routes news items to wiki pages, and executes improvements through the existing crux content pipeline. Includes CLI commands, GitHub Actions workflow for daily scheduled runs, and run history tracking. Added cumulative digest memory (file-based, no DB). Added two internal dashboard pages: Auto-Update Runs (run history, budget tracking) and Auto-Update News (browse discovered news items, sources, routing decisions). Added CLAUDE.md guideline for always building dashboards alongside new features.

**Pages:** (none — infrastructure-only)

**Issues encountered:**
- None

**Learnings/notes:**
- The existing `crux updates` system (staleness-based) is complementary — auto-update is news-driven while updates is schedule-driven
- RSS parsing uses lightweight regex extraction rather than an XML parser dependency
- Web search sources use the existing Anthropic web_search tool via the LLM layer
- The system has a two-stage routing approach: fast entity ID matching first, then LLM routing for unmatched items
- Budget controls are built into both the CLI and the GitHub Actions workflow
- Cumulative digest memory uses a flat YAML state file (no DB needed) — `seen_items` is a hash→date map pruned to 90 days
- Internal dashboards can read YAML files directly via `fs` in Next.js server components — no need to add everything to `build-data.mjs`
- Always build internal dashboards for new features (added to CLAUDE.md as a guideline)
