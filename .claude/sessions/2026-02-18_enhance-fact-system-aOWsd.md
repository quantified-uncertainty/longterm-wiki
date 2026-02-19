## 2026-02-18 | enhance-fact-system-aOWsd | Enhance fact system on Anthropic stakeholders page

**What was done:** Added 8 new canonical facts to `data/facts/anthropic.yaml` (Google stake %, Google/Amazon investments, founder equity totals, EA-aligned capital range), a new `equity-stake-percent` measure, and built a programmatic `AnthropicStakeholdersTable` React component with derived "Exp. Donated" and "Exp. EA-Effective" columns that auto-scale with the current valuation fact. Updated the MDX page to use `<F>` components for volatile inline figures.

**Pages:** anthropic-stakeholders

**Model:** sonnet-4

**Duration:** ~30min

**Issues encountered:**
- None

**Learnings/notes:**
- The fact system allows range values as `[min, max]` arrays; use these for uncertainty ranges
- New table component pattern: server component calling `getFact` directly to read live fact values, then computing derived values for each row and totals in TableFooter
