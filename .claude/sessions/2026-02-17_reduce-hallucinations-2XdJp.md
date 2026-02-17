## 2026-02-17 | claude/reduce-hallucinations-2XdJp | Add hallucination reduction research page

**What was done:** Created a new wiki page on reducing hallucinations in AI-generated wiki content using the Crux content pipeline. The page covers RAG, WikiChat, prompt engineering, verification techniques, fine-tuning, human-in-the-loop systems, and their limitations, with 71 citations from Perplexity research.

**Pages:** reducing-hallucinations

**PR:** #189

**Issues encountered:**
- Crux synthesis phase timed out at 300s when using Claude CLI subprocess; succeeded with `--api-direct` flag using the Anthropic API directly
- Firecrawl package not installed (`@mendable/firecrawl-js`), so source fetching was skipped; synthesis relied on Perplexity summaries only
- SCRY searches timed out for EA Forum and LessWrong
- Entity type `response` is not in the schema; used `approach` instead

**Learnings/notes:**
- When synthesis times out, `--api-direct` mode bypasses the Claude CLI subprocess and uses the Anthropic API directly, which is more reliable
- The `--phase` flag allows resuming individual pipeline phases without re-running the full pipeline
- Entity types for responses should be `approach` or `policy`, not `response` (which isn't in the Zod schema)
