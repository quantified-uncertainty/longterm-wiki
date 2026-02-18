## 2026-02-18 | claude/resolve-issue-271-Qn7cO | Fix broken auto-update sources and add health check

**What was done:** Fixed 4 broken auto-update news sources (navigating-ai-risks 403, anthropic-blog 404, meta-ai-blog 404, the-gradient 502) and replaced the single arxiv web-search source with 3 direct RSS feeds (cs.AI, cs.CL, cs.LG). Implemented `pnpm crux auto-update sources --check` health check command that tests all RSS/Atom source URLs with HEAD-then-GET fallback.

**Pages:** (none — infrastructure-only)

**Model:** sonnet-4

**Duration:** ~30min

**Issues encountered:**
- Running the health check revealed 3 additional broken sources beyond the ones mentioned in the issue (anthropic-blog, meta-ai-blog, the-gradient) — all fixed in the same PR
- navigatingrisks.ai domain is unreachable (connection refused), while the Substack subdomain returns 403 for automated requests — switched to web-search

**Learnings/notes:**
- `rss.arxiv.org/rss/cs.AI` etc. work well and return 200 reliably
- Anthropic and Meta AI removed their RSS feeds; web-search is the only option
- HEAD-then-GET fallback in health check handles servers that block HEAD (e.g., some Substack instances)
