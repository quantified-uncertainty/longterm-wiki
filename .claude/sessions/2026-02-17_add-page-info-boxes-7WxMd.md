## 2026-02-17 | claude/add-page-info-boxes-7WxMd | Add PageStatus and info boxes to internal pages

**What was done:** Enabled PageStatus rendering, Data links, and Feedback widgets on internal pages by removing the `isInternal` guards in the wiki page renderer. Added `evergreen`, `update_frequency`, and `lastEdited` frontmatter to all ~40 internal pages so update schedules and staleness indicators are visible.

**Pages:** about-this-wiki, ai-transition-model-style-guide, anthropic-pages-refactor-notes, architecture, automation-tools, cause-effect-diagrams, common-writing-principles, content-database, documentation-maintenance, enhancement-queue, gap-analysis-2026-02, importance-ranking, knowledge-base, longterm-strategy, longterm-vision, longtermwiki-value-proposition, mermaid-diagrams, models, models-style-guide, page-length-research, page-types, parameters-strategy, project-roadmap, rating-system, research-reports, response-style-guide, risk-style-guide, stub-style-guide, schema/diagrams, schema/entities, schema/index, reports/index, index

**Issues encountered:**
- The build script reads `update_frequency` (snake_case) from frontmatter, not `updateFrequency` (camelCase). Initially used the wrong casing and had to fix across all files.

**Learnings/notes:**
- Internal pages are detected via `entityPath.startsWith("/internal")` in `app/src/app/wiki/[id]/page.tsx`
- The build system at `app/scripts/build-data.mjs` uses `fm.update_frequency` for the frontmatter field name
- `JsonLd`, `LlmWarningBanner`, `DataInfoBox`, and `RelatedPages` remain intentionally hidden for internal pages
