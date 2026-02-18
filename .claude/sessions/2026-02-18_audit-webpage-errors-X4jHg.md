## 2026-02-18 | claude/audit-webpage-errors-X4jHg | Audit wiki pages for factual errors and hallucinations

**What was done:** Systematic audit of ~20 wiki pages for factual errors, hallucinations, and inconsistencies. Found and fixed 18+ confirmed errors across 14 pages, including wrong dates, fabricated statistics, false attributions, missing major events, and internal inconsistencies.

**Pages:** geoffrey-hinton, nick-bostrom, dario-amodei, fhi, apollo-research, openai, anthropic, early-warnings, miri-era, deep-learning-era, cset, epistemic-orgs-epoch-ai, bioweapons, sam-altman, 80000-hours

**Issues encountered:**
- Many pages have zero citations, making verification harder
- Fabricated statistics (round percentages like "300%", "400%", "50-75%") are a recurring pattern across LLM-generated content
- Several cross-page inconsistencies (e.g., OpenAI employee letter count differs between openai.mdx and sam-altman.mdx)
- Some claims are borderline - sourced differently across reputable sources (e.g., Anthropic cofounder count, Stripe investment year)

**Learnings/notes:**
- Pages with the most specific numerical claims (percentages, growth rates) are most likely to contain hallucinations
- Biographical pages frequently have wrong educational details (degrees, institutions, dates)
- Date errors are extremely common - CBS 60 Minutes date, Apollo Research founding, Sam Altman wedding, AlphaGo announcement timing
- Pages written about organizations the LLM is very familiar with (Anthropic, OpenAI) tend to be more accurate than those about smaller orgs
- The hallucination-risk tool correctly identifies high-risk pages but cannot detect specific errors - manual review + web verification is essential
- Many remaining unverified claims exist across the wiki that were not fixed in this session (see report for full list of unfixed suspicious items)
