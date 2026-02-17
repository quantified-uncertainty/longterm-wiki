## 2026-02-17 | claude/review-pr-92-UquRc | Add Calc component for inline fact calculations

**What was done:** Implemented the `<Calc>` component from closed PR #92 — a recursive-descent expression evaluator (`calc-engine.ts`) and React component (`Calc.tsx`) that computes derived values from canonical facts inline in MDX pages, with hover tooltips showing formula and inputs.

**Pages:** anthropic

**Issues encountered:**
- PR #92 branch was deleted from remote, so the implementation was rebuilt from the PR diff
- `build-data.mjs` must be run from the `app/` directory (uses `process.cwd()` for paths)
- Dollar signs in `<F>` children text needed `\$` escaping to pass MDX validation

**Learnings/notes:**
- The calc engine mirrors the existing `computed-facts.mjs` recursive-descent parser used at build time, but runs at render time for ad-hoc expressions in MDX
- `<Calc>` complements `<F>` (single fact display) by supporting arbitrary math expressions over multiple facts
