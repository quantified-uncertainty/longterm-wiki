## 2026-02-19 | claude/enhance-fact-system-aOWsd | Enhanced Anthropic stakeholders table with column toggles and fact refs

**What was done:** Continued enhancing the Anthropic stakeholders page fact system. Added 5 new canonical facts (per-founder stake, Tallinn stake, Moskovitz stake, employee pledge rate, employee EA alignment estimate). Refactored `AnthropicStakeholdersTable` into a server+client component split — the server wrapper reads the valuation fact via `getFact()`, while the new `AnthropicStakeholdersTableClient` is a `"use client"` component with column visibility toggles, wider layout, pledge shown as ranges (25–50% for employee pool instead of misleading "50%"), and hoverable canonical fact ID badges for auditability.

**Pages:** anthropic-stakeholders

**Model:** sonnet-4-6

**Duration:** ~45min

**Issues encountered:**
- `getFact()` uses `fs.readFileSync` so cannot be called in a client component — required server+client split.
- Previous session had left 5 files modified but uncommitted; continued from that state after pulling rebase.

**Learnings/notes:**
- Any component that needs client-side state AND calls `getFact()` must be split: server wrapper passes data as props to client child.
- When a fact represents a range (like employee pledge rate varying by hire date), use `pledgeMin`/`pledgeMax` in the component rather than a single value — ranges communicate uncertainty honestly.
- Canonical fact IDs in component data (as `stakeFactRef`, `pledgeFactRef`) provide a lightweight audit trail without adding a full facts-lookup UI.
