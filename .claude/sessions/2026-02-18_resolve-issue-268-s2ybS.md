## 2026-02-18 | claude/resolve-issue-268-s2ybS | Replace LLM web search with Exa API for auto-update sources

**What was done:** Replaced the `executeWebSearch` (Anthropic Sonnet + web_search_20250305 tool) call in the auto-update feed fetcher with the Exa API as the primary search method. Added graceful fallback to the LLM-based search when `EXA_API_KEY` is unset or Exa errors. Also replaced the `arxiv-ai-safety` web-search source in `sources.yaml` with two reliable RSS feeds (`arxiv.org/rss/cs.AI` and `arxiv.org/rss/cs.CL`).

**Pages:** (none — infrastructure-only change)

**Model:** sonnet-4

**Duration:** ~20min

**Issues encountered:**
- None

**Learnings/notes:**
- Exa API endpoint: `https://api.exa.ai/search` (POST). Key fields: `type: "auto"`, `numResults`, `startPublishedDate`, `contents.text.maxCharacters`.
- Exa returns `publishedDate` as an ISO string; the LLM fallback assigns today's date.
- arxiv RSS feeds are more reliable and cheaper than web-searching for arxiv papers.
