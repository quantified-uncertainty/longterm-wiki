## 2026-02-15 | claude/internal-pages-infrastructure-Y2TWq | Internal pages entity infrastructure

**What was done:** Added full entity infrastructure to internal pages (style guides, architecture docs, research reports, schema docs). Internal pages now have the `internal` entity type, get auto-assigned E* numeric IDs (E698-E731), are included in the search index, and participate in backlinks/related graph computation. Includes review fixes: filtering internal pages from public explore/home, converting all 7 remaining .md files, adding `internal` to data/schema.ts, and updating all `shouldSkipValidation`/`pageType === 'documentation'` checks.

**Pages:** about-this-wiki, anthropic-pages-refactor-notes, architecture, automation-tools, cause-effect-diagrams, content-database, documentation-maintenance, enhancement-queue, gap-analysis-2026-02, knowledge-base, longtermwiki-value-proposition, mermaid-diagrams, models, page-length-research, page-types, rating-system, research-reports, response-style-guide, risk-style-guide, ai-research-workflows, causal-diagram-visualization, controlled-vocabulary, cross-link-automation-proposal, diagram-naming-research, page-creator-pipeline, diagrams, entities, common-writing-principles, longterm-vision, longterm-strategy, stub-style-guide, parameters-strategy, models-style-guide, ai-transition-model-style-guide

**Issues encountered:**
- Original commit missed 7 `.md` files (only converted `.mdx` files)
- Internal pages leaked into public explore page — no filter for `entityType === 'internal'`
- `shouldSkipValidation()` still checked only `pageType`, missing new `entityType: internal`
- `data/schema.ts` EntityType enum was not updated (consistency gap)

**Learnings/notes:**
- Internal pages were previously skipped by both the frontmatter scanner and the ID assignment pipeline via `skipCategories`
- The `reports` and `schema` subcategories within `internal/` also needed to be removed from `skipCategories` since the category is computed from subdirectory paths
- Internal pages are now accessible at both `/internal/slug` and `/wiki/E*` routes
- The `pageType` field in frontmatter was replaced with `entityType: internal` (not kept alongside)
- When adding a new entity type, must update ALL THREE files: entity-type-names.ts, entity-ontology.ts, AND data/schema.ts
- Must also update `shouldSkipValidation()` and direct `pageType` checks when migrating pageType to entityType
