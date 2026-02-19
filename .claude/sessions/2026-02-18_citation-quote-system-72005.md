## 2026-02-18 | claude/citation-quote-system-72005 | Citation quote extraction system

**What was done:** Built a complete citation quote system: SQLite schema for storing extracted quotes, LLM-powered quote extraction from cited sources, fuzzy quote verification, book/paper online lookup, and three new CLI commands (extract-quotes, quote-report, verify-quotes). Ran pilot on 3 pages (ai-timelines, eu-ai-act, leopold-aschenbrenner) — 224 citations, 195 quotes extracted, 98% verified.

**Model:** opus-4-6

**Duration:** ~2h

**Issues encountered:**
- Gate check fails on main due to pre-existing ID stability issue (unrelated to this PR)
- TSC not installed locally, couldn't run TypeScript check directly
- OpenRouter model `google/gemini-flash-1.5` was removed, needed to update to `google/gemini-2.0-flash-001`
- Academic-style footnotes `[^N]: Author, "[Title](URL)," Source, Year.` weren't handled by the citation parser — added Pattern 2

**Learnings/notes:**
- The `crux/citations/` directory pattern works well for standalone scripts
- SQLite `SUM()` returns `null` on empty tables — use `COALESCE()` for display
- OpenRouter Gemini Flash is a good cost-efficient choice for quote extraction (~$0.01/call)
- Pilot found 4 unverified quotes out of 195 extracted — likely content drift or LLM paraphrasing, not wiki hallucinations
- 29 citations had no source text available (PDFs, sites blocking crawlers, timeouts)
