# Dead Code Report

Comprehensive analysis of unused code in the longterm-wiki codebase.

---

## Summary

| Category | Items Found | Est. Dead Lines |
|----------|-------------|-----------------|
| Entirely orphaned files | 6 | ~800 |
| Dead components | 4 + 2 barrel files | ~250 |
| Dead exports in `app/src/data/` | ~70 functions/types | ~2,000 |
| Dead exports in `crux/lib/` | ~30 functions/types | ~400 |
| Dead validation scripts/types | 2 files | ~100 |
| **Total** | **~110 items** | **~3,500 lines** |

---

## 1. Entirely Orphaned Files (can be deleted)

### `crux/lib/search.ts`
Zero importers anywhere. The build-time equivalent `app/scripts/lib/search.mjs` is used instead.

### `crux/lib/redundancy.ts`
Only imported by its own test `crux/lib/redundancy.test.ts`. No production consumers. The build-time equivalent `app/scripts/lib/redundancy.mjs` is used instead.

### `crux/validate/validate-redundancy.ts`
Not referenced from `commands/validate.ts` or `validate-all.ts`. Can only be run manually.

### `crux/validate/types.ts`
Exports `ValidatorOptions`, `ValidatorResult`, `ValidatorIssue`, `FileIssues` -- none are imported anywhere.

### `app/scripts/flatten-content.mjs`
One-time migration script. Not called from `build-data.mjs` or `package.json`. Only a comment reference remains.

### `app/src/data/tables/deployment-architectures.ts`
Entirely unused (~180 lines). `DeploymentArchitecturesTableView.tsx` imports from `ai-architectures.ts` instead.

---

## 2. Dead React Components

### `app/src/components/TableOfContents.tsx`
Not imported anywhere. Not in `mdx-components.tsx`. Not used in any MDX file. Completely orphaned.

### `app/src/components/wiki/FullWidthLayout.tsx`
Registered in `mdx-components.tsx` but never used in any MDX file. The component renders `null` -- a no-op kept "for backward compatibility" but no pages reference it.

### `app/src/components/tables/shared/TableInsightsSummary.tsx`
Only appears in the barrel `tables/shared/index.ts` (which is itself never imported). No actual consumers.

### `app/src/components/tables/shared/TableViewHeader.tsx`
Same situation -- only in the dead barrel file. Table view pages use `TableViewPage` which has its own header.

### Dead barrel exports (never imported by any consumer)
- `app/src/components/wiki/index.ts`
- `app/src/components/tables/shared/index.ts`

---

## 3. Massive Dead Export Files in `app/src/data/`

### `app/src/data/master-graph-data.ts` (~1,400 dead lines)
Only `getCategories` and `getOverviewEdges` are used. **24 exported functions/types are dead:**
- `getOverviewNodes`, `getDetailedNodes`, `getDetailedEdges`
- `getExpandedNodes`, `getExpandedEdges`, `getGraphData`
- `getNodesForCategory`, `extractSubgraph`, `getSubgraphSpec`, `getAvailableSubgraphs`
- `getMasterGraphStats`, `getFilterCategories`, `getCategoryColor`
- `getFilteredDetailedData`, `getInteractiveViewData`
- `getInteractiveNodes`, `getInteractiveEdges`
- `getEntitySubgraph`, `hasEntitySubgraph`, `getNodeHrefFromMaster`
- Types: `FilterCategoryInfo`, `EdgeDensity`, `InteractiveCategory`, `InteractiveViewData`

### `app/src/data/parameter-graph-data.ts` (~25 dead exports)
- `getImpactGrid`, `impactGrid`, `getImpactsFrom`, `getImpactsTo`, `getNodeLabel`
- `getEdgesFrom`, `getEdgesTo`, `getSubItem`, `getSubItemDebates`
- `getSubItemRatings`, `getSubItemRelatedContent`, `getSubItemScope`
- `getFactorScenarioLabels`, `getScenarioFactorLabels`
- `getScenarioOutcomeLabels`, `getOutcomeScenarioConnections`, `getOutcomeScenarioLabels`
- `SUBGROUP_COLORS`, `INTERMEDIATE_COLORS`, `getNodeColors`
- Types: `ImpactGridEntry`, `ScenarioInfluence`, `FactorInfluence`, `OutcomeConnection`, `SubItemRatings`, `KeyDebate`, `RelatedContentLink`, `MetricLink`, `RelatedContent`, `RawGraphDataExport`

### `app/src/data/insights-data.ts` (7 of 9 functions unused)
- `getInsightsBySource`, `getAllTags`, `getAllTypes`, `getInsightsByType`
- `getInsightsByStatus`, `getRecentInsights`, `getInsightStats`
- Type: `InsightStatus`

### `app/src/data/index.ts` (deprecated wrappers + unused types)
- Functions: `getExpertInfoBoxData`, `getOrgInfoBoxData`, `getFactValue` (test-only)
- Types: `RelatedGraphEntry`, `BacklinkEntry`, `Entity`, `Resource`, `Publication`, `Expert`, `Organization`
- Re-exports: `isRisk`, `isPerson`, `isOrganization`, `isPolicy`

### `app/src/data/entity-schemas.ts` (20+ individual schemas only used internally)
All individual `*EntitySchema` exports (RiskEntitySchema, PersonEntitySchema, etc.) are only consumed by the discriminated union within the same file. They could be non-exported.
- Also: `OLD_TYPE_MAP`, `OLD_LAB_TYPE_TO_ORG_TYPE` re-exports are unused (consumers import from `entity-type-names.ts` directly)

### `app/src/data/entity-ontology.ts`
- `OrgTypeDefinition` interface -- only used internally
- `ORG_TYPE_DISPLAY` -- only used internally

### `app/src/data/entity-type-names.ts`
- `CANONICAL_ENTITY_TYPE_NAMES`, `CanonicalEntityTypeName`, `ENTITY_TYPE_ALIAS_NAMES` -- only used internally
- `resolveEntityType` -- never imported

### `app/src/data/tables/accident-risks.ts`
- `getRisksByCategory`, `getRisksByAbstractionLevel`, `getRelatedRisks`

### `app/src/data/tables/safety-generalizability.ts`
- `getSafetyGeneralizabilityNodes`, `getSafetyGeneralizabilityEdges`

---

## 4. Dead Exports in `crux/lib/`

### `crux/lib/mdx-utils.ts` (10 dead functions)
- `getRawFrontmatter`, `replaceFrontmatter`, `hasFrontmatter`
- `extractH2Sections`, `extractHeadings`, `countWords`, `extractLinks`
- `shouldSkipValidationFull`, `shouldSkipValidationByPath`, `shouldSkipPosition`
- `getFrontmatterEndLine`

### `crux/lib/sidebar-utils.ts` (3 of 4 exports dead)
- `getSidebarAutogeneratePaths`, `checkSidebarCoverage`, `checkNewPageVisibility`
- Types: `SidebarCoverageResult`, `PageVisibilityResult`

### `crux/lib/anthropic.ts`
- `processBatch` -- never imported
- `RateLimitError` -- only used internally
- `parseYamlResponse` -- test-only

### `crux/lib/openrouter.ts`
- `quickResearch` -- never imported
- `callOpenRouter` -- only used internally (by `perplexityResearch`)

### `crux/lib/knowledge-db.ts`
- `getResearchContext` -- never imported
- `claims` object -- only used internally

### `crux/lib/file-utils.ts`
- `walkDirectory` -- never imported

### `crux/lib/cli.ts`
- `SCRIPTS_DIR` -- only used internally (could be unexported)

### `crux/lib/validation-engine.ts` (5 types only used internally)
- `FixSpec`, `SidebarConfig`, `IssueOptions`, `ValidateOptions`, `FormatOptions`

### `crux/commands/validate.ts`
- `listRules` -- exported but never imported

---

## 5. Dead Exports in `app/src/lib/`

### `app/src/lib/wiki-nav.ts`
- `getWikiSidebarTitle` -- never imported
- `NavItem` re-export -- never imported

### `app/src/lib/page-types.ts`
- `PageTypeInfo`, `ContentFormatInfo`, `PageType` -- never imported externally

---

## 6. Standalone Scripts Not Wired into CLI

These scripts exist but are unreachable from `pnpm crux`:
- `crux/authoring/bootstrap-update-frequency.ts`
- `crux/authoring/reassign-update-frequency.ts`

---

## Recommendations

### Quick wins (safe to delete now)
1. Delete `crux/lib/search.ts` (orphaned)
2. Delete `crux/validate/validate-redundancy.ts` (orphaned)
3. Delete `crux/validate/types.ts` (orphaned)
4. Delete `app/src/data/tables/deployment-architectures.ts` (orphaned)
5. Delete `app/src/components/TableOfContents.tsx` (orphaned)
6. Delete `app/src/components/tables/shared/TableInsightsSummary.tsx` (dead)
7. Delete `app/src/components/tables/shared/TableViewHeader.tsx` (dead)
8. Remove `FullWidthLayout` from `mdx-components.tsx` and delete the component
9. Delete dead barrel files: `components/wiki/index.ts`, `components/tables/shared/index.ts`

### High-impact cleanup
10. Audit `master-graph-data.ts` -- ~1,400 lines of dead graph code. Was an interactive graph viewer planned and abandoned?
11. Audit `parameter-graph-data.ts` -- ~25 dead exports for similar graph features
12. Clean up `insights-data.ts` -- remove 7 unused query functions
13. Clean up `crux/lib/mdx-utils.ts` -- remove 10 dead utility functions
14. Clean up `crux/lib/sidebar-utils.ts` -- remove 3 dead functions
15. Remove deprecated wrappers in `data/index.ts` (`getExpertInfoBoxData`, `getOrgInfoBoxData`, `Entity` type)

### Lower priority (unexport, don't delete)
16. Make individual `*EntitySchema` exports non-exported in `entity-schemas.ts`
17. Unexport internal-only types in `validation-engine.ts`
18. Unexport `SCRIPTS_DIR` in `cli.ts`
19. Unexport internal-only functions in `anthropic.ts`, `openrouter.ts`
