---
title: "Project Roadmap"
description: "Future work, infrastructure improvements, and project tracking"
sidebar:
  order: 10
lastEdited: "2026-01-02"
importance: 2
quality: 29
llmSummary: "Internal project roadmap tracking wiki infrastructure status (14 validators, quality grading, dashboard all complete as of Jan 2026) and future priorities including batch content improvement for high-importance/low-quality pages and increased citation coverage. Emphasizes pragmatic approach: avoid over-engineering, adapt style guidelines to content."
ratings:
  novelty: 0
  rigor: 3
  rigor_reasoning: "Clear tracking of completed vs future work with specific system status, but no sourcing since it's internal project documentation"
  actionability: 5
  actionability_reasoning: "Provides specific tasks (batch content improvement with command-line examples, citation coverage goals) but only relevant to maintainers"
  completeness: 6
  completeness_reasoning: "Comprehensive view of infrastructure state and future work, well-organized with clear status indicators"
---
This file tracks future infrastructure improvements and project priorities. For content-specific tasks, see the [Enhancement Queue](/internal/enhancement-queue/).

## Current State (January 2026)

The project has mature infrastructure:

| System | Status | Notes |
|--------|--------|-------|
| Validation Suite | ✅ Complete | 14 validators covering style, links, MDX, Mermaid, staleness, redundancy |
| Quality Grading | ✅ Complete | Claude API-powered grading (0-100 quality/importance) |
| Dashboard | ✅ Complete | `/dashboard/` with quality distribution, `/dashboard/graph/` for relationships |
| Knowledge Base | ✅ Complete | SQLite cache with article/source extraction and AI summaries |
| Resource Linking | ✅ Complete | `<R>` component with bidirectional tracking, metadata extraction |
| Page Type System | ✅ Complete | overview/content/stub classification |
| Freshness Tracking | ✅ Complete | `reviewBy`, `contentDependencies`, staleness validator |

---

## Future Work

### Content Quality

- [ ] **Batch content improvement** - Systematically upgrade high-importance, low-quality pages
  - Use `node scripts/page-improver.mjs --list` to identify priorities
  - Target: All pages with importance > 60 and quality < 40

- [ ] **Citation coverage** - Many pages lack external citations
  - Resource manager can convert links: `npm run resources process [page] --apply`
  - Goal: Every substantive claim has a source

### Tooling (Low Priority)

- [ ] **Vale integration** - Prose linting for terminology consistency
  - Would catch mechanical style issues (hedging, passive voice)
  - Deferred: Current validators cover structural issues well

- [ ] **VS Code snippets** - Scaffolding templates for new pages
  - Low effort (~30 min), zero installation
  - Templates for: risk, response, model, debate pages

### Style Guide

- [x] **Common writing principles** - Cross-cutting style guide for epistemic honesty, language neutrality, analytical tone
  - Created at `/internal/common-writing-principles/`
  - Added 7th rating dimension: **objectivity** (0-10)
  - All domain style guides reference it

- [ ] **Re-grade pages with objectivity dimension** - Existing pages don't have objectivity scores
  - Run `grade-content.mjs` with `--apply` to add objectivity ratings
  - Prioritize analysis/model pages where epistemic honesty matters most

- [ ] **Audit existing pages for insider language** - Many pages likely use "EA" as adjective
  - Could build a crux validator to flag "EA money", "non-EA", "EA causes" etc.
  - Apply going forward; retroactive cleanup is lower priority

- [x] **Model page guidance** - Models style guide complete at `/internal/models-style-guide/`

- [ ] **Component usage patterns** - Document when to use:
  - EstimateBox vs plain tables
  - Mermaid diagrams vs prose explanations
  - KeyQuestions component

---

## Completed

### December 2025

**Infrastructure:**
- Quality dashboard at `/dashboard/`
- Freshness tracking (`reviewBy`, `contentDependencies`, staleness validator)
- Page type system (overview/content/stub)
- Redundancy detection validator
- Wiki statistics on About page
- Mermaid diagram validator
- Comparison operator validator
- Dollar sign escaping validator

**Content:**
- Entity naming refactor for consistency
- Parameter pages restructured
- Concepts directory page (LessWrong-style layout)

### Earlier

- kb-2.0 style guide
- Full validation suite (style, links, MDX, data integrity, etc.)
- Knowledge base system (scan + summarize)
- Resource manager CLI
- Quality grading system

---

## Notes

- **Don't over-engineer** - Add tooling only when manual process becomes painful
- **Style guide is guidelines, not law** - Adapt to content, don't force templates
- Run `npm run validate` before committing to catch issues early
