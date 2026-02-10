# Task: Audit Stub Components & Add Missing UI Primitives

> **Created:** 2026-02-09
> **Depends on:** [PLAN_FOR_MIGRATION_GAPS.md](./PLAN_FOR_MIGRATION_GAPS.md) (Tier 3.2 and Tier 1.1)

---

## Part 1: Stub Component Audit

### Background

`app/src/components/mdx-components.tsx` registers 58 stub components that render as gray `<div>` placeholders. These are remnants of the Astro/Starlight migration — components that existed in the old app but haven't been ported to Next.js.

The stubs prevent MDX compilation errors (pages can reference `<KeyQuestions>` without crashing), but users see empty gray boxes instead of content.

### Audit Results

Of the 58 stubs, **53 are referenced in MDX content** and **5 are dead code**.

#### Unreferenced — Safe to Remove (5)

These are never used in any MDX file. Remove them from the `stubNames` array:

| Component | Notes |
|-----------|-------|
| `Crux` | `CruxList` and `DataCrux` are used, but bare `Crux` is not |
| `Code` | Starlight component, not used in any MDX |
| `Steps` | Starlight component, not used |
| `Icon` | Starlight component, not used |
| `FileTree` | Starlight component, not used |

#### High-Priority — Used in Many Files (4)

These show gray placeholders across dozens of pages. Porting them would have the highest visible impact.

| Component | Files | Description |
|-----------|-------|-------------|
| `KeyQuestions` | 86 | Key questions section — used on nearly every knowledge-base page |
| `Section` | 26 | Content section wrapper with title — used across people, responses, debates |
| `DisagreementMap` | 25 | Disagreement/crux visualization — used on people and debate pages |
| `KeyPeople` | 24 | Key people section — used on response and approach pages |

#### Medium-Priority — Used in 2-5 Files (8)

| Component | Files | Example pages |
|-----------|-------|---------------|
| `FactorRelationshipDiagram` | 5 | ATM overview pages (scenarios, factors) |
| `ImpactList` | 5 | ATM overview pages |
| `FullWidthLayout` | 4 | Dashboard pages, ATM table |
| `Tags` | 4 | Worldview pages (doomer, optimistic, governance-focused) |
| `FactorGauges` | 3 | ATM overview pages (factors, outcomes, scenarios) |
| `Badge` | 2 | Internal reports (diagram-naming, ai-research-workflows) |
| `ModelsList` | 2 | Risk pages (cyberweapons, bioweapons) |
| `Tabs` / `TabItem` | 2 | Internal reports (controlled-vocabulary, enhancement-queue) |

#### Low-Priority — Used in 1 File Each (39)

Most of these are in internal/experimental pages (`insight-grid-experiments.mdx`, `risk-trajectory-experiments.mdx`, `dashboard/index.mdx`). A few are in public-facing pages.

**In experimental/internal pages (likely not worth porting individually):**
- `InsightGridExperiments`, `InsightScoreMatrix`, `KnowledgeTreemap`, `PixelDensityMap`, `PriorityMatrix`, `ResearchFrontier`, `SparseKnowledgeGrid`, `TopicQuestionGrid` — all in `insight-grid-experiments.mdx`
- `DualOutcomeChart`, `FactorAttributionMatrix`, `FullModelDiagram`, `RiskDashboard`, `RiskTrajectoryExperiments`, `TrajectoryLines` — all in `risk-trajectory-experiments.mdx`
- `QualityDashboard`, `EntityGraph`, `Table`, `TableBody`, `TableCell`, `TableHead`, `TableHeader`, `TableRow` — in `dashboard/` pages
- `AnthropicFact` — in `anthropic-pages-refactor-notes.mdx`
- `EstimateBox` — in `internal/knowledge-base.mdx`
- `ResourceCite`, `ResourceList` — in `internal/content-database.mdx`

**In public-facing pages (higher value to port):**
- `ArticleSources` — in `nist-ai-rmf.mdx`
- `ConceptsDirectory` — in `directory.mdx`
- `CruxList` — in `cruxes/epistemic-risks.mdx`
- `DataCrux`, `DataEstimateBox` — in `responses/longterm-wiki.mdx`
- `ImpactGrid` — in `factors-overview.mdx`
- `InsightsTable` — in `insight-hunting/insights.mdx`
- `OutcomesTable` — in `outcomes-overview.mdx`
- `PageIndex` — in `browse/index.mdx`
- `ResourcesIndex` — in `browse/resources.mdx`
- `RootFactorsTable` — in `factors-overview.mdx`
- `ScenariosTable` — in `scenarios-overview.mdx`
- `TagBrowser` — in `browse/tags.mdx`
- `TimelineViz` — in `agi-timeline-debate.mdx`

### Recommended Actions

**Step 1: Remove 5 dead stubs** from the `stubNames` array in `mdx-components.tsx`. These are: `Crux`, `Code`, `Steps`, `Icon`, `FileTree`.

**Step 2: Consider alternative approaches for high-use stubs.** For the top 4 (`KeyQuestions`, `Section`, `DisagreementMap`, `KeyPeople`), decide whether to:
- **(a) Port them** from `cairn/apps/longterm/src/components/wiki/` — requires understanding the data they consume and adapting to the Next.js data layer.
- **(b) Build simpler replacements** — e.g., `KeyQuestions` might just render a bulleted list from frontmatter, `Section` is likely just an `<h3>` + wrapper div.
- **(c) Remove them from MDX content** — rewrite the 86+ pages to not use these components (high effort, questionable value).

**Step 3: Delete or archive experimental pages** that exist only to showcase unported components. Pages like `insight-grid-experiments.mdx` and `risk-trajectory-experiments.mdx` are internal experiments that render as walls of gray boxes. Consider moving them to an `_archive/` directory or deleting them until the components they depend on are built.

**Step 4: Leave remaining low-priority stubs in place.** They prevent compilation errors and are harmless. Port them opportunistically as the wiki's feature set grows.

### How to Port a Stub Component

For each component you decide to port:

1. **Find the source** in `cairn/apps/longterm/src/components/wiki/<ComponentName>.tsx`
2. **Check its imports** — it may depend on Astro-specific APIs, data functions, or other unported components
3. **Adapt data access** — replace `import { getEntities } from '../../data'` patterns with `import { ... } from '@data'`
4. **Decide server vs client** — most display components can be RSC (server components). Only add `"use client"` if they need interactivity (hover, click, state).
5. **Register in mdx-components.tsx** — replace the stub entry with a real import
6. **Test** — check that pages using the component render correctly

---

## Part 2: Missing shadcn/ui Primitives

### Current State

**Installed (7):** badge, card, collapsible, data-table, sidebar, sortable-header, table

**Not installed (7):** button, hover-card, input, select, tabs, toggle-group, toggle

No `components.json` exists — shadcn/ui was set up manually (components copied in by hand, not via `npx shadcn@latest add`). Only 2 `@radix-ui` packages are installed: `react-collapsible` and `react-slot`.

### What Needs Each Missing Component

| Component | Needed by | Priority |
|-----------|-----------|----------|
| `button` | Nearly every interactive feature — tables, dialogs, filters, forms | High |
| `tabs` | Tabs/TabItem stubs (2 MDX pages), future table view toggles, ATM views | High |
| `input` | Search/filter in EntityIndex, ContentHub, table filters | Medium |
| `select` | Column visibility, filter dropdowns in table system | Medium |
| `toggle` | Column toggles, view mode switches | Medium |
| `toggle-group` | View mode selector (table/matrix/graph), column visibility groups | Medium |
| `hover-card` | Entity hover previews (EntityLink enhancement) | Low |

### How to Install

Since there's no `components.json`, the easiest approach is to initialize shadcn/ui properly and then add components:

```bash
cd app

# Option A: Initialize shadcn/ui (creates components.json, may adjust tailwind config)
npx shadcn@latest init

# Then add missing components
npx shadcn@latest add button tabs input select toggle toggle-group hover-card
```

```bash
# Option B: Add manually (matches existing pattern — no components.json needed)
# Copy component source from https://ui.shadcn.com/docs/components/<name>
# Install required @radix-ui dependency
# Create file in src/components/ui/<name>.tsx
```

**Radix dependencies that will be needed:**

| Component | Radix Package |
|-----------|---------------|
| button | none (pure Tailwind + react-slot, already installed) |
| tabs | `@radix-ui/react-tabs` |
| input | none (pure Tailwind) |
| select | `@radix-ui/react-select` |
| toggle | `@radix-ui/react-toggle` |
| toggle-group | `@radix-ui/react-toggle-group` |
| hover-card | `@radix-ui/react-hover-card` |

### Recommended Order

1. **button** — no new dependencies, most broadly useful
2. **input** — no new dependencies, needed for search/filter
3. **tabs** — needed for Tabs/TabItem MDX stubs and ATM views
4. **select** — needed for table column visibility
5. **toggle + toggle-group** — needed for table view toggles
6. **hover-card** — nice-to-have for EntityLink previews, lowest priority

### After Installing

- The `Tabs` and `TabItem` MDX stubs can be replaced with real components backed by the shadcn `tabs` primitive
- The `Badge` MDX stub can potentially be replaced by the existing `ui/badge.tsx` (check if the API matches)
- Future table system components will import from these primitives
