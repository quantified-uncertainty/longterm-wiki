## 2026-02-17 | claude/add-recoding-america-page-PrFse | Add state capacity and Recoding America pages

**What was done:** Created two new wiki pages via the Crux content pipeline: a concept page on "State Capacity and AI Governance" (imp=72, qual=75) and a book page on "Recoding America" by Jennifer Pahlka (imp=62, qual=60). Also fixed a bug in `crux/authoring/creator/research.ts` where the Perplexity research error handler would overwrite manually injected research data — now preserves existing research if it has real sources.

**Pages:** state-capacity-ai-governance, recoding-america

**PR:** #179

**Issues encountered:**
- External research APIs (Perplexity, SCRY, Firecrawl, canonical links) all failed due to network restrictions in the sandbox environment
- First synthesis attempt timed out (300s) using Claude CLI subprocess mode; switched to `--api-direct` which worked
- With `--api-direct` but zero research data, the synthesis model correctly refused to write (no hallucinated citations) — had to inject web research data manually into the pipeline's temp directory
- Research error handler used `require()` in an ESM module — fixed to use `import`ed `fs`/`path`

**Learnings/notes:**
- When external APIs are unreachable, research data can be manually injected into `.claude/temp/page-creator/{topic}/perplexity-research.json` in the expected format
- The `--api-direct` flag is much more reliable than the Claude CLI subprocess for synthesis in constrained environments
- The research preservation fix in `research.ts` should help future sessions avoid the same overwrite issue
