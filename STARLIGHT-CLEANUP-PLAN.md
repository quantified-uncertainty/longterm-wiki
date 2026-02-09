# LongtermWiki Post-Migration Cleanup Plan

This repo was ported from an Astro/Starlight documentation site to Next.js 15. The migration left significant cruft behind. This document describes every cleanup task with exact file locations, counts, and instructions.

---

## Task 1: Remove Dead Starlight Import Statements (34 files)

**Problem:** 34 MDX files still contain `import ... from '@astrojs/starlight/components'` lines. The Next.js build preprocessor (`preprocessMdx()`) strips these before compilation, so they're dead code that adds confusion.

**Action:** Delete the entire import line (the full line matching `import.*from '@astrojs/starlight/components'`) from each file. Do NOT remove imports from `@components/wiki` — those are real.

**Exact files and their import lines:**

```
content/docs/index.mdx:
  import { Card, CardGrid } from '@astrojs/starlight/components';

content/docs/project/strategy-brainstorm.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/project/changelog.mdx:
  import { Code } from '@astrojs/starlight/components';

content/docs/project/similar-projects.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/project/vision.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/project/critical-insights.mdx:
  import { Aside, Badge } from '@astrojs/starlight/components';

content/docs/internal/reports/causal-diagram-visualization.mdx:
  import { Aside, Card, CardGrid } from '@astrojs/starlight/components';

content/docs/internal/reports/diagram-naming-research.mdx:
  import { Aside, Badge } from '@astrojs/starlight/components';

content/docs/internal/reports/controlled-vocabulary.mdx:
  import { Aside, Badge, Tabs, TabItem } from '@astrojs/starlight/components';

content/docs/internal/reports/ai-research-workflows.mdx:
  import { Aside, Badge } from '@astrojs/starlight/components';

content/docs/internal/reports/page-creator-pipeline.mdx:
  import { Aside, Badge } from '@astrojs/starlight/components';

content/docs/internal/mermaid-diagrams.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/internal/enhancement-queue.mdx:
  import { Tabs, TabItem, Badge } from '@astrojs/starlight/components';

content/docs/internal/research-reports.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/internal/cause-effect-diagrams.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/internal/architecture.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/internal/content-database.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/internal/models.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/internal/documentation-maintenance.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/insight-hunting/quantitative-claims.mdx:
  import { LinkCard } from '@astrojs/starlight/components';

content/docs/insight-hunting/table-candidates.mdx:
  import { LinkCard } from '@astrojs/starlight/components';

content/docs/insight-hunting/gap-analysis.mdx:
  import { LinkCard } from '@astrojs/starlight/components';

content/docs/insight-hunting/index.mdx:
  import { Card, CardGrid } from '@astrojs/starlight/components';

content/docs/knowledge-base/models/safety-culture-equilibrium.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/knowledge-base/models/intervention-effectiveness-matrix.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/knowledge-base/models/worldview-intervention-mapping.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/knowledge-base/models/intervention-timing-windows.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/knowledge-base/models/alignment-robustness-trajectory.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/knowledge-base/models/public-opinion-evolution.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/knowledge-base/models/regulatory-capacity-threshold.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/knowledge-base/models/parameter-interaction-network.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/knowledge-base/models/ai-risk-portfolio-analysis.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/knowledge-base/models/post-incident-recovery.mdx:
  import { Aside } from '@astrojs/starlight/components';

content/docs/knowledge-base/models/safety-research-value.mdx:
  import { Aside } from '@astrojs/starlight/components';
```

**Verification:** After removal, `grep -r "@astrojs/starlight" content/` should return 0 results.

---

## Task 2: Remove `pageTemplate` Frontmatter Field (~261 files)

**Problem:** The `pageTemplate` field is a Starlight-specific concept. The Next.js app does not read or use this field at all. It clutters frontmatter across 261 files.

**Action:** Remove the `pageTemplate: <value>` line from the YAML frontmatter of every MDX file that has it. The field appears as a single line between the `---` fences, like:

```yaml
pageTemplate: knowledge-base-response
```

or:

```yaml
pageTemplate: knowledge-base-risk
```

or:

```yaml
pageTemplate: knowledge-base-model
```

or:

```yaml
pageTemplate: ai-transition-model-sub-item
```

or:

```yaml
pageTemplate: ai-transition-model-factor
```

or:

```yaml
pageTemplate: ai-transition-model-scenario
```

or:

```yaml
pageTemplate: splash
```

**Approach:** Use a regex/sed to remove any line matching `^pageTemplate:.*$` that falls between the first and second `---` in each `.mdx` file. Also remove any resulting blank lines left behind (don't leave double blank lines in frontmatter).

**Verification:** `grep -r "^pageTemplate:" content/` should return 0 results.

---

## Task 3: Clean Up `content/docs/index.mdx` Hero Field

**Problem:** The main `content/docs/index.mdx` still has Starlight's `hero:` frontmatter block with `tagline:`, `actions:`, and `icon:` fields. None of this is used by Next.js.

**Action:** Remove the entire `hero:` block from the frontmatter. The current frontmatter is:

```yaml
---
title: LongtermWiki
description: Strategic intelligence for AI safety prioritization...
pageTemplate: splash
hero:
  tagline: A structured resource for AI safety prioritization
  actions:
    - text: Explore All Content
      link: /explore/
      icon: seti:notebook
    - text: AI Transition Model
      link: /ai-transition-model/
      icon: right-arrow
      variant: minimal
---
```

After cleanup it should be:

```yaml
---
title: LongtermWiki
description: Strategic intelligence for AI safety prioritization - a structured resource for understanding AI risks and interventions
---
```

(The `pageTemplate: splash` line will already be removed by Task 2.)

---

## Task 4: Resolve Duplicate `goal-misgeneralization.mdx`

**Problem:** This file exists in TWO locations:

1. `content/docs/knowledge-base/risks/goal-misgeneralization.mdx` — Title: "Goal Misgeneralization", quality: 63, importance: 78.5, lastEdited: "2026-01-29". This is the **risk** page describing the failure mode.

2. `content/docs/knowledge-base/responses/goal-misgeneralization.mdx` — Title: "Goal Misgeneralization Research", quality: 58, importance: 72.5, lastEdited: "2025-01-28". This is the **response/research** page about solving the problem.

**Action:** These are actually two different pages that happen to share the same filename slug. The responses version should be renamed to avoid the collision:

- Rename `content/docs/knowledge-base/responses/goal-misgeneralization.mdx` → `content/docs/knowledge-base/responses/goal-misgeneralization-research.mdx`
- Update any references in `data/entities/` YAML files that point to the slug `goal-misgeneralization` for the response entity — change the `id` to `goal-misgeneralization-research`
- Update the id-registry.json entry if one exists for this response entity
- Search for any `<EntityLink id="goal-misgeneralization">` references in MDX files that were intended to point at the research page (likely none — most would point at the risk)

---

## Task 5: Move Misplaced Files to Correct Directories

### 5a: `foundation-models/large-language-models.mdx` → `capabilities/`

**Problem:** `content/docs/knowledge-base/foundation-models/` contains a single file (`large-language-models.mdx`) and has no corresponding entity type mapping. LLMs are a capability.

**Action:**
1. Move `content/docs/knowledge-base/foundation-models/large-language-models.mdx` → `content/docs/knowledge-base/capabilities/large-language-models.mdx`
2. Delete the now-empty `content/docs/knowledge-base/foundation-models/` directory
3. Update `data/` YAML files and `pathRegistry` references if any point to the old path

### 5b: `reports/ea-biosecurity-scope.mdx` → `responses/`

**Problem:** `content/docs/knowledge-base/reports/` contains a single file with `pageTemplate: knowledge-base-response`, meaning it belongs in `responses/`.

**Action:**
1. Move `content/docs/knowledge-base/reports/ea-biosecurity-scope.mdx` → `content/docs/knowledge-base/responses/ea-biosecurity-scope.mdx`
2. Delete the now-empty `content/docs/knowledge-base/reports/` directory
3. Update references as needed

---

## Task 6: Clean Up Stub Components in `mdx-components.tsx`

**File:** `app/src/components/mdx-components.tsx`

**Problem:** There are 55+ stub component names (lines 38-55) that render as generic gray `<div>` placeholders. Many of these are referenced by zero MDX files and are dead weight. Others are referenced by files that should be rewritten to not use them.

**Action:** This is a two-part task:

### 6a: Identify which stubs are actually referenced in MDX files

For each component name in the `stubNames` array, grep `content/docs/` to see if any MDX file actually uses it. Components with ZERO references in content can be removed from the stub list entirely.

### 6b: Clean up the Aside adapter

The `Aside` function (lines 25-30) adapts Starlight's `<Aside>` to the `<Callout>` component. After Task 1 removes the Starlight imports, the `<Aside>` component references in MDX content still need to work (they're injected via the components map). So keep the `Aside` adapter BUT add a comment noting it's a legacy compat shim.

### 6c: Clean up the comment on line 32

Change `// Placeholder for Astro-only or not-yet-ported components` to reflect reality — most of these will never be ported; they were part of Astro experiments that are now dead.

---

## Task 7: Add Non-Standard Directories to Entity Type Mapping

**Problem:** The following `knowledge-base/` subdirectories exist but are NOT in the entity type → directory mapping in `tooling/validate/validate-data.mjs`:

| Directory | # Files | Recommendation |
|-----------|---------|----------------|
| `debates/` | 12 | Add as entity type `debate` or map to `crux` |
| `intelligence-paradigms/` | 17 | Add as entity type `concept` or new type `intelligence-paradigm` |
| `metrics/` | 11 | Add as entity type `metric` |
| `future-projections/` | 6 | Add as entity type `scenario` |
| `history/` | 5 | Add as entity type `historical` |
| `worldviews/` | 5 | Add as entity type `concept` |
| `forecasting/` | 3 | Merge into `models/` or add mapping |
| `incidents/` | 2 | Add as entity type `event` |

**Action:** For each directory, either:
- (A) Add a new entry to the `pathMapping` object in `tooling/validate/validate-data.mjs`, OR
- (B) If the directory truly doesn't fit, move the files into an existing standard directory and use `subcategory` frontmatter for grouping

**Recommended approach:** Option (A) — add them to the mapping. These directories are well-organized and their content makes sense where it is. The entity type system in `app/src/data/entity-ontology.ts` should also be updated to include any new types.

Here are the files in each directory:

**debates/**: agi-timeline-debate, case-against-xrisk, case-for-xrisk, index, interpretability-sufficient, is-ai-xrisk-real, open-vs-closed, pause-debate, regulation-debate, scaling-debate, why-alignment-easy, why-alignment-hard

**intelligence-paradigms/**: biological-organoid, brain-computer-interfaces, collective-intelligence, dense-transformers, genetic-enhancement, heavy-scaffolding, index, light-scaffolding, minimal-scaffolding, neuro-symbolic, neuromorphic, novel-unknown, provable-safe, sparse-moe, ssm-mamba, whole-brain-emulation, world-models

**metrics/**: alignment-progress, capabilities, compute-hardware, economic-labor, expert-opinion, geopolitics, index, lab-behavior, public-opinion, safety-research, structural

**future-projections/**: aligned-agi, index, misaligned-catastrophe, multipolar-competition, pause-and-redirect, slow-takeoff-muddle

**history/**: deep-learning-era, early-warnings, index, mainstream-era, miri-era

**worldviews/**: doomer, governance-focused, index, long-timelines, optimistic

**forecasting/**: agi-development, agi-timeline, index

**incidents/**: claude-code-espionage-2025, index

---

## Task 8: Create Stub MDX Files for Missing Core Entity Registry Entries

**Problem:** 60 entities in `data/id-registry.json` have no corresponding MDX file. Some are `tmc-*` entries (which are used by ATM `<TransitionModelContent>` components and are fine). But ~19 are core concepts that should have pages.

**Action:** For each of these missing core entities, create a minimal stub MDX file in the appropriate `knowledge-base/` subdirectory:

**Missing core entities that need stub pages:**

| Entity Slug | Likely Directory | Entity Type |
|-------------|-----------------|-------------|
| `adversarial-robustness` | `knowledge-base/responses/` | approach |
| `ai-executive-order` | `knowledge-base/responses/` | policy |
| `ai-safety-summit` | `knowledge-base/responses/` | event |
| `ai-takeover` | `knowledge-base/risks/` | risk |
| `ai-timelines` | `knowledge-base/models/` | concept |
| `autonomous-replication` | `knowledge-base/risks/` | risk |
| `benchmarking` | `knowledge-base/responses/` | approach |
| `bio-risk` | `knowledge-base/risks/` | risk |
| `compute-monitoring` | `knowledge-base/responses/` | approach |
| `compute-thresholds` | `knowledge-base/responses/` | policy |
| `content-moderation` | `knowledge-base/responses/` | approach |
| `cyber-offense` | `knowledge-base/risks/` | risk |
| `dual-use` | `knowledge-base/risks/` | concept |
| `existential-risk` | `knowledge-base/risks/` | concept |
| `fast-takeoff` | `knowledge-base/models/` | concept |
| `field-building` | `knowledge-base/responses/` | approach |
| `natural-abstractions` | `knowledge-base/responses/` | approach |
| `prosaic-alignment` | `knowledge-base/responses/` | approach |
| `scaling-laws` | `knowledge-base/models/` | concept |
| `superintelligence` | `knowledge-base/risks/` | concept |
| `transformative-ai` | `knowledge-base/models/` | concept |
| `value-learning` | `knowledge-base/responses/` | approach |

**Stub template:**

```mdx
---
title: "[Title Case of Slug]"
description: "TODO: Add description"
sidebar:
  order: 50
quality: 0
importance: 0
lastEdited: "2026-02-09"
---

This page is a stub. Content needed.
```

**Do NOT create stubs for `tmc-*` entries** — those are served by the `<TransitionModelContent>` component on ATM pages and don't need standalone MDX files.

**Do NOT create stubs for these entity slugs** that have registry entries but are legitimately handled by existing pages or components: `agi-capabilities`, `ai-ownership`, `ai-uses`, `civilizational-competence`, `data-constraints`, `economic-disruption-impact`, `economic-disruption-model`, `human-catastrophe`, `misalignment-potential`, `transition-turbulence`. These are ATM framework concepts that map to existing ATM pages under different slugs.

---

## Task 9: Verify and Test

After completing all the above:

1. Run `node tooling/crux.mjs validate` — all pre-existing checks should still pass
2. Run `pnpm build` from the `app/` directory — should build successfully
3. Run `pnpm test` — all tests should pass
4. Spot-check that `/wiki/E1` through a few random entity URLs still resolve correctly

---

## Summary of Changes

| Task | Files Affected | Type |
|------|---------------|------|
| 1. Remove Starlight imports | 34 MDX files | Delete lines |
| 2. Remove `pageTemplate` field | ~261 MDX files | Delete frontmatter field |
| 3. Clean up index.mdx hero | 1 file | Remove frontmatter block |
| 4. Resolve duplicate file | 2 files (rename 1) | Rename + update refs |
| 5. Move misplaced files | 2 files + 2 empty dirs | Move + delete dirs |
| 6. Clean up stub components | 1 TSX file | Audit + trim |
| 7. Add directory mappings | 1-2 tooling files | Add config entries |
| 8. Create missing entity stubs | ~22 new MDX files | Create stubs |
| 9. Verify | — | Run validation + build |

**Total estimated file touches:** ~320 files modified, ~22 new files, 2 files moved, 2 directories deleted.
