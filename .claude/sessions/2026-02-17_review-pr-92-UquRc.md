## 2026-02-17 | claude/review-pr-92-UquRc | Add Calc component for inline fact calculations

**What was done:** Implemented the `<Calc>` component from closed PR #92 — a recursive-descent expression evaluator (`calc-engine.ts`) and React component (`Calc.tsx`) that computes derived values from canonical facts inline in MDX pages, with hover tooltips showing formula and inputs. Integrated into the Crux content pipeline (synthesis + improvement prompts, component-imports validation, new hardcoded-calculations advisory rule). Full retrofit of anthropic-ipo.mdx as demonstration: ~25 hardcoded values converted to `<F>` and `<Calc>`, 6 new facts added to YAML.

**Pages:** anthropic, anthropic-ipo

**Issues encountered:**
- PR #92 branch was deleted from remote, so the implementation was rebuilt from the PR diff
- `build-data.mjs` must be run from the `app/` directory (uses `process.cwd()` for paths)
- Dollar signs in `<F>` children text needed `\$` escaping to pass MDX validation
- Needed to add several facts (revenue-early-2025, revenue-mid-2025, valuation-nov-2025, etc.) before the page's derived values could be computed

**Learnings/notes:**
- The calc engine mirrors the existing `computed-facts.mjs` recursive-descent parser used at build time, but runs at render time for ad-hoc expressions in MDX
- `<Calc>` complements `<F>` (single fact display) by supporting arbitrary math expressions over multiple facts
- The hardcoded-calculations rule detected 331 existing instances across the wiki — these are advisory (INFO) and can be converted incrementally via the improve pipeline
- Three integration points for new components: validation rules (component-imports.ts), synthesis prompt (creator/synthesis.ts), improvement prompt (page-improver/phases.ts)
- Be careful with `<F>` wrapping — don't wrap a value with the wrong fact ID (e.g. "$30B raise" is not the same as "$67B total funding")
- Tables (funding rounds, revenue history) are fine left hardcoded — the value of `<F>` is in prose where the same number is repeated and can drift
