## 2026-02-19 | claude/review-checklist-system-S1EpS | Add check/verify commands to reduce checklist friction

**What was done:** Reviewed the checklist system (PR #282) and analyzed 15 post-checklist PRs — none used the checklist. Root cause: too much friction (each checkbox requires 2-3 tool calls to edit markdown). Added `check` and `verify` subcommands to `agent-checklist` CLI. `check` marks items by ID in one command. `verify` auto-runs verifiable items (gate, escaping, TypeScript) and marks them done. Also numbered checklist items with explicit IDs and tagged auto-verifiable items.

**Model:** opus-4-6

**Duration:** ~1h

**Issues encountered:**
- `--na` flag consumed the next positional arg as its value due to CLI parser behavior. Fixed with rescue logic.
- Pre-existing TypeScript errors throughout crux/ (100+) — none from our changes.

**Learnings/notes:**
- Checklist fatigue is a human problem, not an AI problem. The real blocker for AI agents is the tool-call cost of editing markdown checkboxes (2-3 calls per item x 28 items = ~60-80 tool calls).
- The `check` command reduces this to 1 call per batch of items.
- 7 items in the catalog now have `verifyCommand` for programmatic verification.
