## 2026-02-19 | claude/citation-pipeline-iteration-KvR2n | Citation pipeline improvements and footnote normalization

**What was done:** Fixed citation extraction to handle all footnote formats (text+bare URL), created a footnote normalization script that auto-converted 58 non-standard footnotes to markdown-link format, switched dashboard export from JSON/.cache to YAML/data/ for production compatibility, ran the citation accuracy pipeline on 5 pages (rethink-priorities, cea, compute-governance, hewlett-foundation, center-for-applied-rationality) producing 232 citation checks with 57% accurate, 16% flagged, re-verified colorado-ai-act archive outside sandbox (18/19 verified), and improved difficulty distribution to use structured categories (easy/medium/hard) with normalization fallback.

**Pages:** neel-nanda, lab-behavior, org-watch, superintelligence

**Model:** opus-4-6

**Duration:** ~1h

**Issues encountered:**
- Sandbox blocks most external URL fetches, requiring dangerouslyDisableSandbox for pipeline runs
- Many wiki pages have footnote definitions but no inline `[^N]` references (sources listed but not cited inline)
- The difficulty distribution from check-accuracy returned long narrative strings — fixed with structured categories and normalization fallback

**Learnings/notes:**
- 89% of footnotes already use the preferred `[^N]: [Title](URL)` format
- Pages with only definitions and no inline refs produce "no quote" results since there's no claim context
- The accuracy checker finds real issues: wrong dates, fabricated details, unsupported claims

**Recommendations:**
- Pages with footnote definitions but no inline `[^N]` references should be flagged for cleanup — they need inline citations added
- Consider running the full pipeline on all 131 pages with footnotes as a batch job
- SQLite citation_quotes data is ephemeral (in .cache/); the YAML exports in data/citation-accuracy/ are the durable record — consider a way to reload from YAML into SQLite for re-checking
