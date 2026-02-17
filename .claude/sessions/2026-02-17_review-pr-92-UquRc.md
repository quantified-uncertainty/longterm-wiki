## 2026-02-17 | claude/review-pr-92-UquRc | Add Calc component for inline fact calculations

**What was done:** Implemented `<Calc>` component from closed PR #92 (recursive-descent evaluator + React component). Integrated into content pipeline (synthesis/improvement prompts, validation rules). Built `pnpm crux fix facts` — a mechanical batch retrofitter that replaces hardcoded fact values with `<F>` components wiki-wide (paragraph-level entity proximity matching, generic value exclusions). Applied across 29 files (59 replacements) plus full manual retrofit of anthropic-ipo.mdx (~25 values, 7 new facts).

**Pages:** anthropic, anthropic-ipo, anthropic-investors, anthropic-valuation, anthropic-pre-ipo-daf-transfers, openai, microsoft, scaling-debate, dense-transformers, economic-labor, frontier-lab-cost-structure, pre-tai-capital-deployment, projecting-compute-spending, risk-interaction-network, ai-revenue-sources, ea-shareholder-diversification-anthropic, frontier-ai-comparison, ftx-collapse-ea-funding-lessons, funders-overview, labs-overview, musk-openai-lawsuit, openai-foundation-governance, us-aisi, dustin-moskovitz, anthropic-core-views, lab-culture, research-agendas, concentration-of-power, anthropic-pledge-enforcement

**Issues encountered:**
- PR #92 branch was deleted from remote, so the implementation was rebuilt from the PR diff
- `build-data.mjs` must be run from the `app/` directory (uses `process.cwd()` for paths)
- Dollar signs in `<F>` children text needed `\$` escaping to pass MDX validation
- Needed to add several facts (revenue-early-2025, revenue-mid-2025, valuation-nov-2025, etc.) before the page's derived values could be computed
- Mechanical fact-retrofit had false positives for generic values ($1B, 100 million, 40-60) on unrelated pages — solved with paragraph-level entity proximity checks and generic value exclusions

**Learnings/notes:**
- The calc engine mirrors the existing `computed-facts.mjs` recursive-descent parser used at build time, but runs at render time for ad-hoc expressions in MDX
- `<Calc>` complements `<F>` (single fact display) by supporting arbitrary math expressions over multiple facts
- The hardcoded-calculations rule detected 331 existing instances across the wiki — these are advisory (INFO) and can be converted incrementally via the improve pipeline
- Three integration points for new components: validation rules (component-imports.ts), synthesis prompt (creator/synthesis.ts), improvement prompt (page-improver/phases.ts)
- Be careful with `<F>` wrapping — don't wrap a value with the wrong fact ID (e.g. "$30B raise" is not the same as "$67B total funding")
- Tables (funding rounds, revenue history) are fine left hardcoded — the value of `<F>` is in prose where the same number is repeated and can drift
- `pnpm crux fix facts` is the new mechanical batch retrofitter — uses paragraph-level entity proximity to avoid false positives. Generic values (round billions, common percentages, ranges) are excluded. Run with `--apply` to write, `--entity=X` to scope to one entity
