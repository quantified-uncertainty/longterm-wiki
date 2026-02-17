## 2026-02-15 | claude/migrate-cairn-pages-3Dzfj | Migrate CAIRN pre-TAI capital pages

**What was done:** Migrated 6 new model pages from CAIRN PR #11 to longterm-wiki, adapting from Astro/Starlight to Next.js MDX format. Created entity definitions (E700-E705). Fixed technical issues (orphaned footnotes, extra ratings fields, swapped refs). Ran Crux improve --tier=polish on all 6 pages for better sourcing, hedged language, and numeric EntityLink IDs. Added cross-links from 4 existing pages (safety-research-value, winner-take-all-concentration, racing-dynamics-impact, anthropic-impact).

**Pages:** pre-tai-capital-deployment, ai-megaproject-infrastructure, safety-spending-at-scale, frontier-lab-cost-structure, ai-talent-market-dynamics, planning-for-frontier-lab-scaling

**PR:** #155

**Issues encountered:**
- numericId conflicts with ea-funding-absorption-capacity (E695) and ftx-collapse-ea-funding-lessons (E696) — resolved by using E700-E705
- CAIRN `ratings` included `focus` and `concreteness` fields not supported by wiki InfoBox — removed
- Multiple pages had orphaned footnotes (defined but never cited inline) — fixed before Crux improve
- Footnotes [^11]/[^12] swapped in pre-tai-capital-deployment — fixed

**Learnings/notes:**
- CAIRN Astro → longterm-wiki Next.js: remove `client:load`, `Backlinks`, `@astrojs/starlight`; DataInfoBox drops `entityId` prop
- Crux improve --tier=polish converts plain-text EntityLink IDs to numeric (E-prefix), adds inline source URLs, adds methodological notes sections, and hedges stronger claims — very effective for CAIRN-migrated content
- Always check MDX frontmatter numericIds for conflicts since build-data auto-creates entities from frontmatter
