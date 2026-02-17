## 2026-02-15 | claude/investigate-foundation-layer-GWqqu | Investigate and integrate Foundation-layer.ai

**What was done:** Investigated foundation-layer.ai, extracted content via Jina reader proxy, then integrated findings into the wiki: created a new organization page, added entity definition, added resource entry, and updated funders-overview with The Foundation Layer Fund and AISTOF.

**Pages:** the-foundation-layer, funders-overview

**PR:** #144

**Issues encountered:**
- Framer site is entirely JS-rendered; direct WebFetch returned only CSS/JS boilerplate
- Solved by using Jina AI reader proxy (`https://r.jina.ai/<url>`)
- Crux `content create` pipeline failed: Perplexity/Firecrawl APIs unreachable due to network restrictions
- Used `--source-file` flag to bypass research phases, but synthesis step (which spawns a `claude` subprocess) hung for 20+ minutes without progress
- Fell back to manual page creation per CLAUDE.md last-resort protocol
- GitHub API inaccessible (local proxy doesn't support it), so issues for missing org pages documented below instead

**Learnings/notes:**
- For JS-rendered sites, `https://r.jina.ai/<url>` renders JS before extracting markdown
- Crux `content create --source-file=<path>` skips research phases when external APIs are blocked
- The spawned `claude` subprocess in the synthesis phase may not work in all environments
- GitHub issues to create (could not be created due to API access):
  1. "Create wiki page: BlueDot Impact" — AI safety talent pipeline org, 1000+ roles identified
  2. "Create wiki page: CAIS Action Fund" — $270K federal lobbying in 2024, sponsored SB 1047
  3. "Create wiki page: AISTOF (AI Safety Tactical Opportunities Fund)" — $30M+, 150+ grants
  4. "Create wiki page: Effective Institutions Project (EIP)" — Tyler John's org, AI safety + geopolitics philanthropy advisory
