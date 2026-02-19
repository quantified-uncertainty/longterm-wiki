## 2026-02-18 | claude/citation-quote-system-72005 | Citation quote extraction system

**What was done:** Built a complete citation quote system: SQLite schema for storing extracted quotes, LLM-powered quote extraction from cited sources, fuzzy quote verification, book/paper online lookup, and three new CLI commands (extract-quotes, quote-report, verify-quotes).

**Model:** opus-4-6

**Duration:** ~45min

**Issues encountered:**
- Gate check fails on main due to pre-existing ID stability issue (unrelated to this PR)
- TSC not installed locally, couldn't run TypeScript check directly

**Learnings/notes:**
- The `crux/citations/` directory pattern works well for standalone scripts
- SQLite `SUM()` returns `null` on empty tables — use `COALESCE()` for display
- OpenRouter Gemini Flash is a good cost-efficient choice for quote extraction (~$0.01/call)
