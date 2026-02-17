## 2026-02-17 | claude/clarify-calc-usage-SMCaw | Canonical facts & Calc usage guide

**What was done:** Created an internal style guide page documenting the strategy for using `<F>` and `<Calc>` components — when numbers should be facts (3-tier decision framework), `<F>` vs `<Calc>` roles, YAML structure, and scaling plan. Added `showDate` prop to the `<F>` component for rendering temporal claims inline (e.g., "300,000+ (as of 2025)"). Added nav entry and CLAUDE.md reference.

**Pages:** canonical-facts

**Issues encountered:**
- None

**Learnings/notes:**
- `<F>` and `<Calc>` currently used on only ~5 pages (all Anthropic-related). Main expansion opportunities are other organizations with volatile financials and cross-referenced field-level metrics.
- The `@components/facts` import path used by anthropic-valuation.mdx is an alias that resolves through the MDX components map in `mdx-components.tsx`, not a separate barrel file.
