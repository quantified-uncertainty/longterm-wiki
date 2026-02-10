# Migration Gaps — What's Not Yet Ported from Astro/Starlight (longterm) to Next.js (longterm-wiki)

> **Last updated:** 2026-02-09
> **Original:** Written when longterm-next lived inside the cairn monorepo. Updated after the repo split to reflect current state.

## Context

The wiki was ported from Astro/Starlight (`cairn/apps/longterm/`) to a standalone Next.js 15 repo (`longterm-wiki/`). The migration is **substantially complete** for tooling and data, but still has significant gaps in frontend features — analytical views, comparison tables, advanced graph features, and many MDX display components remain unported.

### What changed since the original document

The repo split (Feb 2025) resolved the biggest architectural questions:
- **longterm-wiki is the sole app.** Content (MDX), data (YAML), and tooling all live here now.
- **YAML data is local.** All entity, fact, resource, insight, and graph YAML lives in `data/`. No longer dependent on the Astro app.
- **Tooling was ported.** The Crux CLI, validation engine (35 rules), content grading, and analysis tools all live in `crux/`.
- **Build pipeline is complete.** `build-data.mjs` transforms YAML + MDX → `database.json` with 15 library modules.

---

## Current Stats

| Category | Old Astro app | Current longterm-wiki | Status |
|----------|--------------|----------------------|--------|
| Components | ~169 | ~51 | ~30% ported |
| Special pages/routes | 21 | 6 | 0 of 21 special pages ported |
| Data modules (TS) | 18 files | 5 files | 13 still missing |
| Library utilities | 5 files | 6 files | 3 missing, 2 new |
| Validation rules | 34 | 35 | **DONE** (exceeded original) |
| Crux CLI domains | 8 | 8 | **DONE** |
| Content/YAML data | in Astro app | local | **DONE** |
| MDX stub components | — | 58 | Many need porting or removal |
| Tests | 2 | 5 (53 assertions) | longterm-wiki ahead |

---

## 1. Special Pages / Routes — Still 0 of 21 Ported

The wiki has 6 routes: `/`, `/wiki`, `/wiki/[id]`, `/wiki/[id]/data`, `/internal/[[...slug]]`, `/internal/facts`. None of the 21 Astro special pages have been ported.

### 1a. Comparison Tables (7 pages) — NOT PORTED

| Page | Description |
|------|-------------|
| Tables Gallery | Index page listing all comparison tables |
| Safety Approaches | Safety vs capability tradeoffs comparison |
| Eval Types | AI evaluation types and strategies |
| Deployment Architectures | Deployment architecture scenarios |
| Architecture Scenarios | Architecture scenario comparisons |
| Accident Risks | Accident risk comparison table |
| Technical Innovations | Technical innovations table |

**Partial progress:** longterm-wiki now has `ui/data-table.tsx` (TanStack React Table wrapper with search/sort), `ui/sortable-header.tsx`, and `wiki/ComparisonTable.tsx`. These provide table infrastructure that didn't exist before, but the 6 domain-specific table views, 6 column definition files, and gallery page are still missing.

**Effort:** Large.

### 1b. Cause-Effect Diagrams (3 pages) — NOT PORTED

Diagrams Gallery, Entity Diagram viewer, Master Graph. The core `CauseEffectGraph` component works with `DataView`, `Legend`, `CauseEffectNode`, `GroupNode`, `SubgroupNode` nodes. But dedicated diagram pages and advanced features (FilterControls, DetailsPanel, InteractiveView, ListView, OutlineView, ClusterNode, ExpandableNode, grouped layout) are still missing.

**Effort:** Medium.

### 1c. Safety Generalizability Views (3 pages) — NOT PORTED

Table, Matrix, and Graph views of safety generalizability data.

**Effort:** Medium.

### 1d. AI Transition Model Views (3 pages) — NOT PORTED

ATM Graph, ATM Data, ATM Index. `TransitionModelContent`, `TransitionModelTable`, and `TransitionModelTableClient` are ported. New `ATMPage` component added. `TransitionModelDataView`, `TransitionModelGraphView`, `TransitionModelNav` are still missing.

**Effort:** Medium.

### 1e. Content Discovery / Insight Hunting (3 pages) — NOT PORTED

Explore (ContentHub), Gap Analysis, Quantitative Claims. `/wiki` with `ExploreGrid` partially covers the explore page. Insight hunting tools completely absent.

**Effort:** Medium-Large.

### 1f. Resource Detail Pages (1 page) — NOT PORTED

Individual resource pages with author, summary, abstract, review, key points.

**Effort:** Small-Medium.

---

## 2. Components — ~51 of ~169 Ported

### 2a. Table System — PARTIALLY PORTED

**Now have:**
- `ui/data-table.tsx` — TanStack React Table wrapper with search, sorting, expandable rows
- `ui/sortable-header.tsx` — Column header with sorting
- `ui/table.tsx` — Basic shadcn table primitives
- `wiki/ComparisonTable.tsx` — Domain-specific comparison table

**Still missing:** All 6 domain-specific table views, 6 column definition files, shared table utilities (ColumnToggleControls, TableInsightsSummary, ViewModeToggle, etc.), TablesGallery, and the 3 safety generalizability views.

### 2b. Advanced CauseEffectGraph Features — NOT PORTED

**Currently have:** Core graph (`index.tsx`), `ZoomContext`, `DataView`, `Legend`, `icons`, `CauseEffectNode`, `GroupNode`, `SubgroupNode`.

**Still missing:** FilterControls, DetailsPanel, InteractiveView, ListView, OutlineView, ClusterContainerNode, ClusterNode, ExpandableNode, layout-grouped.

### 2c. Data/Analysis/Dashboard Components — NOT PORTED

ContentHub, ContentTree, MasterGraphViewer, MetaView, QualityDashboard, RiskTrajectoryExperiment, InsightGridExperiment, GapAnalysisTable, QuantitativeClaimsView, TableCandidatesView, LiteratureList — all still missing.

### 2d. Forecasts Components — NOT PORTED

ForecastCard, PageForecasts — still missing.

### 2e. Wiki Display Components — MOSTLY NOT PORTED

~25+ components still missing. Currently have replacements for some (EstimatesCard, InterventionsCard, WarningIndicatorsCard, FactorStatusCard), but most entity discovery, factor/model analysis, and data display components are absent.

**58 stub components** in `mdx-components.tsx` render as gray placeholder divs. These need auditing — some are referenced in MDX content and should be ported, others are dead.

### 2f. Shared Wiki Utilities — NOT PORTED

Only `style-config.ts` is ported. 12 others missing (Badge, EmptyCell, FilterToggleGroup, ItemsCell, PillLink, ScoreCell, SeverityBadge, StatBox, TrendCell, useToggleSet, createDataWrapper, index).

### 2g. UI Primitives (shadcn/ui) — PARTIALLY PORTED

**Now have (7):** badge, card, collapsible, data-table, sidebar, sortable-header, table.

**Still missing:** button, hover-card, input, select, tabs, toggle-group, toggle.

### 2h. Transition Model Components — PARTIALLY PORTED

**Have:** TransitionModelContent, TransitionModelTable, TransitionModelTableClient, ATMPage (new).

**Missing:** TransitionModelDataView, TransitionModelGraphView, TransitionModelNav.

---

## 3. Data Layer — MOSTLY RESOLVED

### 3a. YAML Data — RESOLVED

All YAML data now lives locally in `data/`:
- `entities/` — 24 YAML files (603 entities)
- `facts/` — 4 YAML files (38 canonical facts)
- `resources/` — resource YAML (3133 resources)
- `insights/` — 6 YAML files (1041 insights)
- `graphs/` — 4 YAML files
- `id-registry.json` — persistent ID mapping

### 3b. Table Data Generators — NOT PORTED (8 files)

Still missing: accident-risks-data, architecture-scenarios-data, architectures-table-data, scenarios-table-data, safety-approaches-data, deployment-architectures-data, eval-types-table-data, safety-generalizability-graph-data. Required before any table pages can be ported.

### 3c. Other Data Modules — NOT PORTED (6 files)

Still missing: content-schemas, database-types, risk-categories, external-links-data, insights-data, page-templates.

---

## 4. Library Utilities — MOSTLY COMPLETE

**Have (6):** mdx.ts, wiki-nav.ts, internal-nav.ts, remark-callouts.ts, page-types.ts, utils.ts

**Still missing (3):** dashboard.ts, graph-analysis.ts, insight-hunting.ts

---

## 5. Build Tooling & Scripts — LARGELY RESOLVED

This was the biggest gap in the original document. It is now substantially closed.

### 5a. Validation System — DONE

The unified validation engine (`crux/lib/validation-engine.mjs`) now has **35 pluggable rules** (exceeding the original 34), 18+ dedicated validation scripts, and runs via `node crux/crux.mjs validate`. Rules cover escaping, markdown, linking, frontmatter, quality, tone, citations, components, entities, and more.

### 5b. Crux CLI — DONE

`crux/crux.mjs` provides 8 domains: validate, analyze, fix, content, generate, resources, insights, gaps.

### 5c. Content Management — PARTIALLY PORTED

`crux/content/` has: page-improver.mjs, grade-content.mjs, regrade.mjs, grade-by-template.mjs, post-improve.mjs.

**Still missing:** page-creator.mjs, add-key-links.mjs (may be in `fix` domain now).

### 5d. Content Generation — PARTIALLY PORTED

`generate-llm-files.mjs` is integrated into the build pipeline. Other generation scripts (generate-content, generate-yaml, generate-summaries, generate-schema-docs, generate-schema-diagrams, generate-data-diagrams, generate-research-reports) may be partially in the `generate` CLI domain.

### 5e. Pre-commit Hooks — EXISTS BUT NOT INSTALLED

Hook file at `crux/hooks/pre-commit` runs `node crux/crux.mjs validate --quick`. But it is **not symlinked** into `.git/hooks/` — needs manual installation.

### 5f. Analysis Tools — LIKELY IN CLI

The `analyze` CLI domain exists. Needs verification of which specific analysis scripts are functional.

### 5g. Forecasting Integration — NOT PORTED

metaforecast refresh/match/display scripts are still missing.

---

## 6. Styling — MINOR GAPS

**Missing:** Icon system (15+ Lucide SVG sidebar icons), entity-index styles, models-list styles.

**Already equivalent:** oklch colors, Tailwind v4, prose typography, footnotes, InfoBox grid, dark mode.

---

## 7. What longterm-wiki Has That the Astro App Didn't

| Feature | Description |
|---------|-------------|
| **`/wiki/[id]/data` page** | Developer page showing metadata, raw MDX, facts, backlinks, entity JSON |
| **`/internal/facts` dashboard** | Canonical facts viewer |
| **`Callout.tsx`** | Native callout/admonition component for `:::note` directives |
| **`MermaidDiagram.tsx`** | Dedicated mermaid rendering component |
| **`StarlightCards.tsx`** | Compatibility shim for Starlight card markup |
| **`ATMPage.tsx`** | Dedicated AI Transition Model page component |
| **`ComparisonTable.tsx`** | Generic comparison table component |
| **`CredibilityBadge.tsx`** | Credibility indicator badge |
| **`entity-ontology.ts`** | Canonical display metadata (icons, colors, badges) per entity type |
| **Discriminated union types** | Stricter TypeScript with per-entity-type schemas |
| **Auto-generated sidebars** | `wiki-nav.ts` builds contextual sidebars from page metadata |
| **Vitest test suite** | 5 test files, 53 assertions |
| **Error boundaries** | Per-route error handling |
| **Server Components** | RSC by default, `"use client"` only when needed |
| **Standalone repo** | Content, data, tooling all in one place (was split across monorepo) |
| **Full build pipeline** | `build-data.mjs` with 15 library modules |
| **GitHub CI** | Automated build + validation workflow |

---

## 8. Remaining Migration Roadmap

### Tier 1: High-Value Frontend Features

**1.1 — Missing shadcn/ui Primitives** (Small effort)
Install: button, hover-card, input, select, tabs, toggle-group, toggle. Prerequisite for many components.

**1.2 — Cause-Effect Diagram Pages** (Medium effort)
Add `/diagrams/`, `/diagrams/[entityId]`, `/diagrams/master-graph` routes. Port FilterControls, DetailsPanel, and alternative views. The graph engine works — needs page wrappers and advanced features.

**1.3 — ATM View Pages** (Medium effort)
Port TransitionModelDataView, TransitionModelGraphView, TransitionModelNav. Add `/ai-transition-model-views/` routes.

### Tier 2: Analytical Features

**2.1 — Table Data Layer** (Medium effort)
Port 8 table data generators. Required before table views can work.

**2.2 — Table System** (Large effort)
Port 6 table views, 6 column definitions, shared table utilities, TablesGallery. Add table routes. Foundation exists (data-table.tsx, ComparisonTable.tsx).

**2.3 — Safety Generalizability Views** (Medium effort)
Port the 3 safety generalizability pages (table/matrix/graph).

### Tier 3: Content Discovery & Display

**3.1 — Entity Discovery Components** (Medium effort)
Port EntityIndex, EntityCard, TagBrowser, RecentUpdates, ConceptsDirectory, Glossary.

**3.2 — Wiki Display Components** (Medium-Large effort)
Port remaining ~25 components. Audit 58 stubs — remove dead ones, port referenced ones. Priority: Crux/DisagreementMap → Factor/Model analysis → KeyPeople/KeyQuestions.

**3.3 — Resource Pages** (Small-Medium effort)
Port resource detail pages and resource index.

### Tier 4: Internal Tools & Analytics

**4.1 — Quality Dashboard** (Medium effort)
Port QualityDashboard + dashboard.ts.

**4.2 — Insight Hunting Pages** (Medium effort)
Port gap analysis, quantitative claims, and table candidates pages.

**4.3 — Forecasts Integration** (Small effort)
Port ForecastCard, PageForecasts, and metaforecast scripts.

### Tier 5: Loose Ends

**5.1 — Install pre-commit hooks** (Tiny effort)
Symlink `crux/hooks/pre-commit` into `.git/hooks/`.

**5.2 — Audit and clean stub components** (Small effort)
Check which of the 58 stubs are actually referenced in MDX. Remove unreferenced ones, prioritize porting referenced ones.

**5.3 — Verify CLI domains are fully functional** (Small effort)
Test each `crux` CLI domain (analyze, fix, content, generate, resources, insights, gaps) end-to-end.

---

## Resolved Decision Points

These were open questions in the original document. All are now resolved:

1. **Will longterm-next replace longterm entirely?** → **Yes.** longterm-wiki is the standalone repo. The Astro app remains in cairn as archive only.

2. **Should table data live in database.json?** → Still open, but the build pipeline (`build-data.mjs`) could accommodate this. Currently table data generators don't exist yet.

3. **Should validation be shared?** → **Moot.** Validation lives entirely in this repo now (35 rules in `crux/lib/rules/`).

4. **How should special pages be routed?** → Still open. Options remain: dedicated routes, layout switching on `[id]` route, or query parameters.

5. **Which stubs should be removed vs ported?** → Still open. Now 58 stubs. Audit needed.
