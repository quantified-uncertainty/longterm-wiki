## 2026-02-18 | claude/update-claude-models-4JrjM | Hallucination risk reduction infrastructure (issue #200)

**What was done:** Implemented Phases 2-4 of the hallucination risk reduction initiative (issue #200): citation density validation rule, balance flags detection rule, human review tracking CLI (`crux review`), and hallucination risk assessment report (`crux validate hallucination-risk`). Updated Claude model verification date to 2026-02-18 (models already at Sonnet 4.6 and Opus 4.6). Built a full citation verification and archival system (`crux citations`) that downloads cited URLs, extracts page titles and content snippets, records HTTP status and fetch timestamps, and stores everything in per-page YAML archives at `data/citation-archive/`.

**Pages:** (no wiki content pages changed — infrastructure only)

**Issues encountered:**
- None

**Learnings/notes:**
- Models were already at claude-sonnet-4-6 and claude-opus-4-6; only the verification date needed updating
- The hallucination risk report found 233 high-risk pages, with 201 having zero citations
- Citation density rule produces 244 warnings across knowledge-base pages
- Phase 1 (actual citation backfill via `crux content improve`) and Phase 5 (medium-risk backfill) require API budget and should be run separately
- Citation archive system tested on sleeper-agents page: all 13 citations verified successfully with full metadata
- Many pages use plain-text footnotes (book/journal references) without URLs — the citation verifier only processes URL-based footnotes
