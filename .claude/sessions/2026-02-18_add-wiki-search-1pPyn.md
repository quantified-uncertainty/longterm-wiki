## 2026-02-18 | claude/add-wiki-search-1pPyn | Add fact-wrap CLI command

**What was done:** Implemented `pnpm crux fix fact-wrap` command (GitHub issue #201) that scans wiki pages for hardcoded numbers matching canonical facts from `data/facts/*.yaml` and wraps them with `<F>` components. Applied to anthropic.mdx (9 wraps), openai.mdx (4 wraps), and sam-altman.mdx (7 wraps).

**Pages:** anthropic, openai, sam-altman

**Model:** opus-4-6

**Duration:** ~45min

**Issues encountered:**
- False positives from cross-entity matching (e.g., "$1 billion" matching Anthropic revenue on OpenAI's page). Solved with low-specificity value detection that restricts common amounts to entity-owned pages only.
- Second occurrences of same fact values could refer to different things (e.g., "$4 billion" as Anthropic revenue vs Amazon investment). Solved by only wrapping first occurrence per fact per page.

**Learnings/notes:**
- Low-specificity values (round dollar amounts, short ranges, percentages, plain numbers with units) should only be matched on the entity's own page to avoid false positives
- The idempotency check that detects already-wrapped `<F>` tags is critical for safe re-runs
- `noCompute` facts with year-like values (e.g., "2003") should be skipped since they represent fixed historical dates
