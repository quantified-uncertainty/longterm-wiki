## 2026-02-13 | claude/wiki-gap-analysis-l7Cp8 | Systematic wiki gap analysis

**What was done:** Ran `crux gaps list`, `crux gaps stats`, and manual topic coverage analysis across all 639 wiki pages. Identified 386 pages needing insight extraction (203 high-importance with zero insights). Produced a gap analysis report at `content/docs/internal/gap-analysis-2026-02.mdx`. Built a Suggested Pages dashboard (`app/internal/suggested-pages/`) with exactly 100 ranked page suggestions (priorities 1–100) in a sortable DataTable, using numeric priority based on mention frequency across existing pages (grep + EntityLink counts) and editorial importance. Updated gap-analysis MDX to reference the dashboard instead of inline tier lists.

**Issues encountered:**
- pnpm install fails on puppeteer postinstall (known issue), `--ignore-scripts` workaround used
- `crux gaps` shows 0 pages when `pages.json` hasn't been built — must run `node app/scripts/build-data.mjs` first
- The gaps tool only finds under-extracted existing pages, not truly missing topics — manual analysis needed for coverage gaps
- Numbered lists starting at >1 without blank lines fail the markdown list formatting test

**Learnings/notes:**
- 93% of tracked pages (482/519) have zero insights — massive insight extraction backlog
- Responses category (136 pages, 3% insight coverage) and organizations (106 pages, 0%) are most under-extracted
- Biggest content gaps: Chinese AI labs (DeepSeek, Mistral), test-time compute, hallucination, prompt injection — all lack dedicated pages
- Only 2 incident pages exist despite many documented AI failures
