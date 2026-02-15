## 2026-02-15 | claude/internal-pages-infrastructure-Y2TWq | Internal pages entity infrastructure

**What was done:** Added full entity infrastructure to internal pages (style guides, architecture docs, research reports, schema docs). Internal pages now have the `internal` entity type, get auto-assigned E* numeric IDs (E698-E724), are included in the search index, and participate in backlinks/related graph computation. Similar to Wikipedia's meta/project namespace pages getting the same infrastructure as article pages.

**Pages:** about-this-wiki, anthropic-pages-refactor-notes, architecture, automation-tools, cause-effect-diagrams, content-database, documentation-maintenance, enhancement-queue, gap-analysis-2026-02, knowledge-base, longtermwiki-value-proposition, mermaid-diagrams, models, page-length-research, page-types, rating-system, research-reports, response-style-guide, risk-style-guide, ai-research-workflows, causal-diagram-visualization, controlled-vocabulary, cross-link-automation-proposal, diagram-naming-research, page-creator-pipeline, diagrams, entities

**Issues encountered:**
- None

**Learnings/notes:**
- Internal pages were previously skipped by both the frontmatter scanner and the ID assignment pipeline via `skipCategories`
- The `reports` and `schema` subcategories within `internal/` also needed to be removed from `skipCategories` since the category is computed from subdirectory paths
- Internal pages are now accessible at both `/internal/slug` and `/wiki/E*` routes
- The `pageType` field in frontmatter was replaced with `entityType: internal` (not kept alongside)
