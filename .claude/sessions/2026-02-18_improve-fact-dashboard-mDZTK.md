## 2026-02-18 | claude/improve-fact-dashboard-mDZTK | Improve Fact Dashboard

**What was done:** Enhanced the Canonical Facts Dashboard with five improvements: (1) "Used in N pages" column with hover-list of linking pages — built via a new `scanFactUsage()` build step that reverse-indexes `<F>` component usage across all MDX; (2) rich hover tooltips on measure badges showing description, direction, category, related measures, applicableTo, and display format; (3) hover tooltips on values showing raw numeric/range/note; (4) an ID convention banner explaining the "bare ID = latest" naming pattern; (5) ontology fix — Worldcoin user-count facts moved from `sam-altman.yaml` to a new `worldcoin.yaml` entity file.

**Pages:** (no wiki pages edited — infrastructure-only)

**Model:** sonnet-4

**Duration:** ~45min

**Issues encountered:**
- `FactUsagePage` forward-referenced in `DatabaseShape` interface before its definition — TypeScript handled it fine (same-file hoisting)
- Display divisor tooltip initially rendered confusingly as `$ ÷1B B`; fixed to `${n}B (÷1,000,000,000)`

**Learnings/notes:**
- `scanFactUsage()` must be called before `rawContent` is stripped from pages (after `scanContentEntityLinks`, before `delete page.rawContent` at line ~1397)
- CSS `group-hover:visible` tooltips with `pointer-events-none` cannot be scrolled; fine for small lists but would need a React state solution if lists grow large
- The `subject:` field on facts controls timeseries exclusion — facts with subject overrides don't appear in the parent entity's timeseries
