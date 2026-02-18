## 2026-02-18 | claude/audit-webpage-errors-11sSF | Fix factual errors found in wiki audit

**What was done:** Systematically audited ~25 high-risk wiki pages for factual errors and hallucinations using 4 parallel background agents plus direct reading. Fixed 10 confirmed errors across 8 files.

**Pages:** deep-learning-era, world-models, anthropic, deepmind, dario-amodei, demis-hassabis, geoffrey-hinton, ilya-sutskever

**Issues encountered:**
- DeepMind acquisition price on demis-hassabis.mdx was \$100M (wrong by ~5x) — corrected to \$500–650M
- Paul Christiano described as "Former MIRI researcher" in deep-learning-era.mdx — corrected to "PhD from UC Berkeley"
- AlphaZero timing "superhuman in 24 hours" in deep-learning-era.mdx and world-models.mdx — corrected to ~4 hours
- Ilya Sutskever's seq2seq paper falsely credited as including "attention" — corrected to stacked LSTMs (Bahdanau et al. 2015 added attention separately)
- Anthropic.mdx temporal contradiction "doubled since early 2026" — corrected to "early 2025"
- Hinton's 60 Minutes date "March 2023" (before he left Google in May 2023) — corrected to October 2023
- Nobel Prize attribution in deepmind.mdx omitted David Baker — added
- Hinton extinction risk "10%" understated — updated to "10–20%" throughout geoffrey-hinton.mdx
- Dario Amodei funding table "\$1B+" inconsistent with body text "\$7B+" — fixed to \$7B+

**Learnings/notes:**
- FLI \$665.8M Buterin donation (SHIB tokens) is accurate in nominal terms; Coefficient Giving rebrand of Open Philanthropy (Nov 18 2025) is confirmed accurate
- AlphaZero timing error appears in 2 separate pages (deep-learning-era.mdx and world-models.mdx) — both fixed
- All three CI-blocking validation checks pass after fixes
