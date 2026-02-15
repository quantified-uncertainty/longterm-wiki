## 2026-02-15 | claude/migrate-cairn-pages-3Dzfj | Migrate CAIRN pre-TAI capital pages

**What was done:** Migrated 6 new model pages from CAIRN PR #11 (quantified-uncertainty/cairn) to longterm-wiki, adapting from Astro/Starlight format to Next.js MDX format. Created entity definitions (E700-E705) in models.yaml.

**Pages:** pre-tai-capital-deployment, ai-megaproject-infrastructure, safety-spending-at-scale, frontier-lab-cost-structure, ai-talent-market-dynamics, planning-for-frontier-lab-scaling

**Issues encountered:**
- numericId conflicts with existing pages (ea-funding-absorption-capacity E695, ftx-collapse-ea-funding-lessons E696) — resolved by using E700-E705 instead
- pnpm install failed initially due to puppeteer download — used PUPPETEER_SKIP_DOWNLOAD=1

**Learnings/notes:**
- CAIRN uses Astro/Starlight components (`<Backlinks />`, `client:load`, `@astrojs/starlight`); longterm-wiki uses Next.js (`@components/wiki`)
- Mermaid syntax differs: CAIRN uses `<Mermaid client:load chart={...}`, wiki uses `<Mermaid chart={...}`
- DataInfoBox: CAIRN uses `entityId` prop; wiki does not
- Always check MDX frontmatter numericIds for conflicts since build-data auto-creates entities from frontmatter
